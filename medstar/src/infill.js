import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Wall infill: material removed from the base wall ABOVE the clamp band,
 * so the articulator's screw clamp always bites solid material low down
 * while the upper wall spends less resin.
 *
 * Every cut is a prism swept along the wall itself: its side faces run
 * radially through the wall and its inner and outer faces sit clear of
 * both wall surfaces. That keeps every intersection square to the
 * surface, and every cutter is disjoint from its neighbours. Those two
 * rules are what let the boolean return a closed mesh; tangent slabs or
 * touching cutters do not.
 */

// Clearance kept between a cut and the band or deck, in millimeters.
const EDGE_MARGIN = 1.2;
// How far a cutter reaches past both wall faces so it always cuts through.
const PIERCE_OVERSHOOT = 2.5;
const MIN_BAND_HEIGHT = 3;
// Sampling density along a swept cut.
const STATION_SPACING = 1.2;
// Keeps a tapered profile from pinching into a degenerate tip.
const MIN_PROFILE_HEIGHT = 0.45;
// Most heading change a single cut may span, in radians (about 20 deg).
const MAX_CUT_TURN = 0.35;
// Text bars cut cleanest with a deeper back face.
const TEXT_DEPTH_FACTOR = 2;

/** Arc-length lookup along a closed outline of Vector2 (x, z) points. */
function measureOutline(points) {
    const count = points.length;
    const cumulative = [0];
    for (let index = 0; index < count; index += 1) {
        const current = points[index];
        const next = points[(index + 1) % count];
        cumulative.push(cumulative[index] + current.distanceTo(next));
    }
    const perimeter = cumulative[count];

    // The chord is the run of minimum z; remember where it starts so text
    // can be laid on the flat posterior wall.
    let chordZ = Infinity;
    for (const point of points) chordZ = Math.min(chordZ, point.y);

    function at(arc) {
        let s = arc % perimeter;
        if (s < 0) s += perimeter;
        let low = 0;
        let high = count;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (cumulative[mid] <= s) low = mid + 1;
            else high = mid;
        }
        const segment = Math.max(0, low - 1);
        const start = points[segment];
        const end = points[(segment + 1) % count];
        const length = cumulative[segment + 1] - cumulative[segment] || 1e-6;
        const t = Math.min(1, Math.max(0, (s - cumulative[segment]) / length));
        const position = new THREE.Vector2().lerpVectors(start, end, t);
        const tangent = new THREE.Vector2().subVectors(end, start).normalize();
        const normal = new THREE.Vector2(-tangent.y, tangent.x);
        return { position, normal };
    }

    // Orient normals outward using a point known to be outside the shape.
    const probe = at(perimeter * 0.25);
    const outward = probe.position.dot(probe.normal) >= 0 ? 1 : -1;

    // The outline starts at the left end of the flat posterior chord and
    // runs along it, so the chord occupies the first stretch of arc.
    let chordLength = 0;
    for (let index = 0; index < count; index += 1) {
        if (Math.abs(points[index].y - chordZ) > 1e-6) break;
        if (Math.abs(points[(index + 1) % count].y - chordZ) > 1e-6) break;
        chordLength = cumulative[index + 1];
    }

    const oriented = arc => {
        const sample = at(arc);
        sample.normal.multiplyScalar(outward);
        return sample;
    };

    return {
        perimeter,
        chordZ,
        chordLength,
        at: oriented,
        /**
         * Largest change in heading anywhere across an arc span, in
         * radians. Comparing only the two ends would wave through a cut
         * that runs from flat wall into a fillet and back.
         */
        turnAcross(arcStart, arcEnd) {
            const samples = 7;
            const normals = [];
            for (let index = 0; index < samples; index += 1) {
                const t = index / (samples - 1);
                normals.push(oriented(arcStart + (arcEnd - arcStart) * t).normal);
            }
            let turn = 0;
            for (let a = 0; a < normals.length; a += 1) {
                for (let b = a + 1; b < normals.length; b += 1) {
                    turn = Math.max(turn, Math.acos(
                        Math.min(1, Math.max(-1, normals[a].dot(normals[b])))
                    ));
                }
            }
            return turn;
        }
    };
}

/**
 * A prism swept along the wall between two arc positions. `profile(t)`
 * returns the [low, high] height pair at t in 0..1, which is what gives a
 * pattern its silhouette.
 */
function buildSweptPrism(outline, arcStart, arcEnd, wall, profile, innerDepth) {
    const span = arcEnd - arcStart;
    const stations = Math.max(2, Math.ceil(Math.abs(span) / STATION_SPACING) + 1);
    const outer = PIERCE_OVERSHOOT;
    const inner = innerDepth ?? (wall + PIERCE_OVERSHOOT);
    const positions = [];
    const rings = [];

    // The inner face is pushed along one fixed direction rather than each
    // station's own normal. Offsetting inward along the local normal by
    // more than the corner radius would fold the inner curve through
    // itself; a constant direction is just a translation, so it cannot.
    const middleNormal = outline.at(arcStart + span / 2).normal.clone();

    for (let index = 0; index < stations; index += 1) {
        const t = index / (stations - 1);
        const sample = outline.at(arcStart + span * t);
        let [low, high] = profile(t);
        if (high - low < MIN_PROFILE_HEIGHT) {
            const middle = (low + high) / 2;
            low = middle - MIN_PROFILE_HEIGHT / 2;
            high = middle + MIN_PROFILE_HEIGHT / 2;
        }

        const outerPoint = new THREE.Vector2()
            .copy(sample.normal).multiplyScalar(outer).add(sample.position);
        const innerPoint = new THREE.Vector2()
            .copy(middleNormal).multiplyScalar(-inner).add(outerPoint);

        rings.push([
            new THREE.Vector3(outerPoint.x, low, outerPoint.y),
            new THREE.Vector3(outerPoint.x, high, outerPoint.y),
            new THREE.Vector3(innerPoint.x, high, innerPoint.y),
            new THREE.Vector3(innerPoint.x, low, innerPoint.y)
        ]);
    }

    const pushTriangle = (a, b, c) => {
        positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    };
    const pushQuad = (a, b, c, d) => {
        pushTriangle(a, b, c);
        pushTriangle(a, c, d);
    };

    for (let index = 0; index < stations - 1; index += 1) {
        const current = rings[index];
        const next = rings[index + 1];
        for (let corner = 0; corner < 4; corner += 1) {
            const following = (corner + 1) % 4;
            pushQuad(
                current[corner],
                current[following],
                next[following],
                next[corner]
            );
        }
    }

    // Caps, wound opposite to each other.
    const first = rings[0];
    const last = rings[stations - 1];
    pushQuad(first[3], first[2], first[1], first[0]);
    pushQuad(last[0], last[1], last[2], last[3]);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(positions, 3)
    );

    // Self-correct the winding so the prism always encloses positive
    // volume, whatever direction the outline happens to run.
    if (signedVolume(positions) < 0) flipWinding(geometry);
    return geometry;
}

function signedVolume(positions) {
    let volume = 0;
    for (let offset = 0; offset < positions.length; offset += 9) {
        const ax = positions[offset];
        const ay = positions[offset + 1];
        const az = positions[offset + 2];
        const bx = positions[offset + 3];
        const by = positions[offset + 4];
        const bz = positions[offset + 5];
        const cx = positions[offset + 6];
        const cy = positions[offset + 7];
        const cz = positions[offset + 8];
        volume += ax * (by * cz - bz * cy)
            - ay * (bx * cz - bz * cx)
            + az * (bx * cy - by * cx);
    }
    return volume / 6;
}

function flipWinding(geometry) {
    const position = geometry.getAttribute('position');
    const array = position.array;
    for (let offset = 0; offset < array.length; offset += 9) {
        for (let axis = 0; axis < 3; axis += 1) {
            const temp = array[offset + 3 + axis];
            array[offset + 3 + axis] = array[offset + 6 + axis];
            array[offset + 6 + axis] = temp;
        }
    }
    position.needsUpdate = true;
}

// ---------------------------------------------------------------------
// Dot matrix font, 5 wide by 7 tall. Each row is a bit pattern read from
// the left. Only the glyphs the wall text needs are defined. A matrix
// keeps every cut disjoint and convex, which is what the boolean needs.
// ---------------------------------------------------------------------

const FONT = {
    M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
    E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
    D: [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
    S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
    T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
    A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
    R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
    O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
    F: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
    ' ': [0, 0, 0, 0, 0, 0, 0]
};

const FONT_COLUMNS = 5;
const FONT_ROWS = 7;

/** The patternable window between the clamp band and the deck. */
export function getInfillBand(params) {
    const low = params.clampBand;
    const high = params.height - params.wall;
    return { low, high, height: high - low };
}

function buildSlotCutters(outline, params, band, { slotWidth, pitch, rows = 1 }) {
    const low = band.low + EDGE_MARGIN;
    const high = band.high - EDGE_MARGIN;
    const available = high - low;
    if (available < 1) return [];

    const rowCount = rows > 1 && available >= 4 ? rows : 1;
    const rowGap = rowCount > 1 ? 1.2 : 0;
    const rowHeight = (available - rowGap * (rowCount - 1)) / rowCount;
    if (rowHeight < 1) return [];

    const count = Math.max(1, Math.floor(outline.perimeter / pitch));
    const step = outline.perimeter / count;
    if (step - slotWidth < 1.5) return [];

    const cutters = [];
    for (let row = 0; row < rowCount; row += 1) {
        const rowLow = low + row * (rowHeight + rowGap);
        const rowHigh = rowLow + rowHeight;
        // Offset alternate rows by half a pitch for a staggered course.
        const shift = (row % 2) * (step / 2);

        for (let index = 0; index < count; index += 1) {
            // Start half a step in so no cut straddles the outline's seam.
            const centre = step / 2 + shift + index * step;
            // Leave the tight posterior fillets solid. A cut spanning that
            // much curvature cannot be squared cleanly through the wall,
            // and a solid corner is the part most likely to take a knock.
            const guard = slotWidth / 2 + 1.5;
            if (outline.turnAcross(centre - guard, centre + guard)
                > MAX_CUT_TURN) {
                continue;
            }

            cutters.push(buildSweptPrism(
                outline,
                centre - slotWidth / 2,
                centre + slotWidth / 2,
                params.wall,
                () => [rowLow, rowHigh]
            ));
        }
    }
    return cutters;
}

// Thinnest bar worth cutting: below this the slot neither prints nor
// drains cleanly.
const MIN_TEXT_BAR = 0.6;

/**
 * Smallest band, in millimeters, that still yields printable lettering.
 * Seven rows of cells, each 70 percent bar, plus the edge margins.
 */
export const TEXT_MIN_BAND = Number(
    ((MIN_TEXT_BAR / 0.7) * FONT_ROWS + EDGE_MARGIN * 2 + 0.5).toFixed(1)
);

function buildTextCutters(outline, params, band) {
    const text = 'MEDSTAR OMFS';
    const usableHeight = band.height - EDGE_MARGIN * 2;
    // Text stays on the flat posterior chord, clear of both fillets.
    const usableWidth = outline.chordLength - 6;
    if (usableWidth <= 0) return [];

    // Square cells, scaled to whichever of the two limits bites first:
    // the band's height or the run of flat wall the line has to fit in.
    const cellsWide = text.length * (FONT_COLUMNS + 1) - 1;
    const pitch = Math.min(usableHeight / FONT_ROWS, usableWidth / cellsWide);
    const barHeight = pitch * 0.7;
    // Bars thinner than this neither print nor drain, so the pattern
    // declines rather than shipping a wall of hairline slots.
    if (barHeight < MIN_TEXT_BAR) return [];

    const rowPitch = pitch;
    const columnPitch = pitch;
    const advance = (FONT_COLUMNS + 1) * columnPitch;
    const totalWidth = text.length * advance - columnPitch;
    if (totalWidth > usableWidth) return [];

    // Arc runs left to right along the chord in world +X, but a reader
    // standing outside sees +X on their left. So the line is laid out
    // from the right end of the chord backwards, which puts it the right
    // way round without mirroring any geometry.
    const rightArc = outline.chordLength / 2 + totalWidth / 2;
    const bottom = band.low + (band.height - FONT_ROWS * rowPitch) / 2;
    const inset = columnPitch * 0.15;
    const cutters = [];

    for (let character = 0; character < text.length; character += 1) {
        const rows = FONT[text[character]] ?? FONT[' '];
        const glyphArc = rightArc - character * advance;

        for (let row = 0; row < FONT_ROWS; row += 1) {
            const bits = rows[row];
            // Row 0 is the top of the glyph.
            const centreY = bottom
                + (FONT_ROWS - 1 - row) * rowPitch
                + rowPitch / 2;

            // Merge each run of lit cells into one bar. Runs are always
            // separated by an unlit cell, so the bars stay disjoint.
            let runStart = -1;
            for (let column = 0; column <= FONT_COLUMNS; column += 1) {
                const lit = column < FONT_COLUMNS
                    && Boolean(bits & (1 << (FONT_COLUMNS - 1 - column)));
                if (lit && runStart < 0) runStart = column;
                if (lit || runStart < 0) continue;

                const from = glyphArc - column * columnPitch + inset;
                const to = glyphArc - runStart * columnPitch - inset;
                runStart = -1;
                cutters.push(buildSweptPrism(
                    outline,
                    from,
                    to,
                    params.wall,
                    () => [centreY - barHeight / 2, centreY + barHeight / 2],
                    params.wall + PIERCE_OVERSHOOT * TEXT_DEPTH_FACTOR
                ));
            }
        }
    }

    return cutters;
}

/**
 * A single cutter solid for the chosen pattern, in the base's local frame
 * (bottom at Y = 0). Returns null when the pattern removes nothing.
 */
export function buildInfillCutterGeometry(params, outlinePoints) {
    if (!params.infill || params.infill === 'solid') return null;

    const band = getInfillBand(params);
    if (band.height < MIN_BAND_HEIGHT) return null;

    const outline = measureOutline(outlinePoints);
    let cutters = [];

    if (params.infill === 'bars') {
        cutters = buildSlotCutters(outline, params, band, {
            slotWidth: 4,
            pitch: 8.5
        });
    } else if (params.infill === 'windows') {
        cutters = buildSlotCutters(outline, params, band, {
            slotWidth: 12,
            pitch: 18
        });
    } else if (params.infill === 'text') {
        cutters = buildTextCutters(outline, params, band);
    }

    if (!cutters.length) return null;

    try {
        return BufferGeometryUtils.mergeGeometries(cutters, false);
    } finally {
        cutters.forEach(cutter => cutter.dispose());
    }
}
