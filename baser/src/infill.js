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
export function measureOutline(points) {
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
         * Snap an arc position onto the nearest outline vertex. The shell's
         * wall is a faceted strip, so a cut that starts or ends part way
         * across a facet shaves a sliver off it and tears the mesh. Landing
         * the cut on the facet boundaries keeps every intersection exact.
         */
        snap(arc, maxShift = 0.75) {
            let s = arc % perimeter;
            if (s < 0) s += perimeter;
            let low = 0;
            let high = count;
            while (low < high) {
                const mid = (low + high) >> 1;
                if (cumulative[mid] <= s) low = mid + 1;
                else high = mid;
            }
            const before = cumulative[Math.max(0, low - 1)];
            const after = cumulative[Math.min(count, low)];
            const nearest = (s - before) <= (after - s) ? before : after;
            // The flat chord is a single long facet with nothing to land
            // on. Leave those cuts where they are: a flat wall has no
            // slivers to shave off in the first place.
            return Math.abs(nearest - s) <= maxShift ? nearest : s;
        },

        /** Outline vertex arc positions strictly inside a span. */
        verticesBetween(arcStart, arcEnd) {
            const inside = [];
            for (let index = 0; index <= count; index += 1) {
                const value = cumulative[index];
                if (value > arcStart + 1e-9 && value < arcEnd - 1e-9) {
                    inside.push(value);
                }
            }
            return inside;
        },
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
    const outer = PIERCE_OVERSHOOT;
    const inner = innerDepth ?? (wall + PIERCE_OVERSHOOT);
    const positions = [];
    const rings = [];

    // Sample at the outline's own vertices so the cut's outer face follows
    // the shell facet for facet, plus evenly spaced interior samples so a
    // shaped profile is described everywhere. The flat posterior chord is
    // one long facet with no interior vertices, so without the even
    // samples any tapered or chamfered cut would collapse to a hairline
    // right across the back of the base.
    const samples = outline.verticesBetween(arcStart, arcEnd);
    const steps = Math.max(1, Math.ceil(Math.abs(span) / STATION_SPACING));
    for (let step = 1; step < steps; step += 1) {
        samples.push(arcStart + span * (step / steps));
    }
    samples.sort((a, b) => a - b);

    const arcs = [arcStart];
    for (const value of samples) {
        if (value - arcs[arcs.length - 1] > 1e-3) arcs.push(value);
    }
    if (arcEnd - arcs[arcs.length - 1] > 1e-3) arcs.push(arcEnd);
    else arcs[arcs.length - 1] = arcEnd;
    const stations = arcs.length;

    // The inner face is pushed along one fixed direction rather than each
    // station's own normal. Offsetting inward along the local normal by
    // more than the corner radius would fold the inner curve through
    // itself; a constant direction is just a translation, so it cannot.
    const middleNormal = outline.at(arcStart + span / 2).normal.clone();

    for (let index = 0; index < stations; index += 1) {
        const t = span === 0 ? 0 : (arcs[index] - arcStart) / span;
        const sample = outline.at(arcs[index]);
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
    A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
    B: [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
    C: [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
    D: [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
    E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
    F: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
    G: [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01111],
    H: [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
    I: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b11111],
    J: [0b00111, 0b00010, 0b00010, 0b00010, 0b00010, 0b10010, 0b01100],
    K: [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
    L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
    M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
    N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
    O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
    P: [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
    Q: [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101],
    R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
    S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
    T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
    U: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
    V: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
    W: [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b11011, 0b10001],
    X: [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
    Y: [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
    Z: [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111],
    0: [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
    1: [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
    2: [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
    3: [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110],
    4: [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
    5: [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
    6: [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
    7: [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
    8: [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
    9: [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
    '.': [0, 0, 0, 0, 0, 0b01100, 0b01100],
    ',': [0, 0, 0, 0, 0b00110, 0b00110, 0b01100],
    "'": [0b00100, 0b00100, 0b01000, 0, 0, 0, 0],
    '&': [0b01100, 0b10010, 0b10100, 0b01000, 0b10101, 0b10010, 0b01101],
    '/': [0b00001, 0b00010, 0b00010, 0b00100, 0b01000, 0b01000, 0b10000],
    '+': [0, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0],
    '-': [0, 0, 0, 0b11111, 0, 0, 0],
    ' ': [0, 0, 0, 0, 0, 0, 0]
};

const FONT_COLUMNS = 5;
const FONT_ROWS = 7;

/**
 * Free-standing round bars for the openings, as one merged solid ready to
 * be unioned onto an already-cut base.
 *
 * The bar is deliberately thinner than the wall so it stands clear of both
 * wall faces. A bar as thick as the wall runs tangent to those faces, and
 * tangency is what shreds the boolean: at wall thickness it leaves about
 * seventy torn edges, and at wall minus one it leaves none.
 */
export function buildWallBars(params, outlinePoints, { spacing, diameter, spin = 0 }) {
    const band = getInfillBand(params);
    if (band.height < MIN_BAND_HEIGHT) return null;

    const outline = measureOutline(outlinePoints);
    const count = Math.max(1, Math.floor(outline.perimeter / spacing));
    const step = outline.perimeter / count;
    const overlap = 1.5;
    const height = band.height + overlap * 2;
    const centreY = (band.low + band.high) / 2;
    // Lettering owns the flat back. A bar standing there would be sliced
    // by the glyph cuts and tear the wall open, so the chord is left bare.
    const clearChord = hasEngraving(params);
    const parts = [];

    for (let index = 0; index < count; index += 1) {
        const sample = outline.at(step / 2 + index * step);
        if (clearChord
            && Math.abs(sample.position.y - outline.chordZ) < diameter) {
            continue;
        }
        // Sit the bar on the wall's centre line so it clears both faces.
        const inward = sample.normal.clone().multiplyScalar(-params.wall / 2);
        const bar = new THREE.CylinderGeometry(
            diameter / 2,
            diameter / 2,
            height,
            16
        );
        if (spin) bar.rotateY(spin);
        bar.translate(
            sample.position.x + inward.x,
            centreY,
            sample.position.y + inward.y
        );
        const flat = bar.toNonIndexed();
        for (const name of Object.keys(flat.attributes)) {
            if (name !== 'position') flat.deleteAttribute(name);
        }
        bar.dispose();
        parts.push(flat);
    }

    try {
        return BufferGeometryUtils.mergeGeometries(parts, false);
    } finally {
        parts.forEach(part => part.dispose());
    }
}

/** The patternable window between the clamp band and the deck. */
export function getInfillBand(params) {
    const low = params.clampBand;
    const high = params.height - params.wall;
    return { low, high, height: high - low };
}

/**
 * Widest cut the anterior arch will accept, in millimeters.
 *
 * A cut is refused where the wall turns more than MAX_CUT_TURN across it,
 * and on a D-shaped base the tightest curve is the front of the arch, not
 * the posterior fillets: its radius is (width/2)^2 / depth. Asking for a
 * wider slot than this does not widen the cuts, it silently deletes the
 * ones around the front and leaves a long solid stretch there.
 */
export function maxSlotWidth(params) {
    const apexRadius = (params.width / 2) ** 2 / params.depth;
    return Math.max(2.5, 0.9 * (MAX_CUT_TURN * apexRadius - 3));
}

// A cut end lands on the nearest wall facet, which can move it by up to
// this much, so the gap between neighbours is designed with the loss
// already priced in.
const SNAP_ALLOWANCE = 1.5;
// Thinnest strip of wall left between two cuts. Below the wall thickness
// the strip stops behaving like a post and starts behaving like a hinge.
const MIN_LIGAMENT = 3;

export function buildSlotCutters(outline, params, band, {
    slotWidth,
    pitch,
    rows = 1,
    rowGap: rowGapOption,
    stagger = true,
    phase = 0,
    profile: profileShape = null
}) {
    const low = band.low + EDGE_MARGIN;
    const high = band.high - EDGE_MARGIN;
    const available = high - low;
    if (available < 1) return [];

    const rowCount = rows > 1 && available >= 4 ? rows : 1;
    const rowGap = rowCount > 1 ? (rowGapOption ?? 1.2) : 0;
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
        const shift = stagger ? (row % 2) * (step / 2) : 0;

        for (let index = 0; index < count; index += 1) {
            // Start half a step in so no cut straddles the outline's seam.
            const centre = step / 2 + shift + phase * step + index * step;
            // Leave the tight posterior fillets solid. A cut spanning that
            // much curvature cannot be squared cleanly through the wall,
            // and a solid corner is the part most likely to take a knock.
            const guard = slotWidth / 2 + 1.5;
            if (outline.turnAcross(centre - guard, centre + guard)
                > MAX_CUT_TURN) {
                continue;
            }

            const from = outline.snap(centre - slotWidth / 2);
            const to = outline.snap(centre + slotWidth / 2);
            if (to - from < 1) continue;

            const profile = profileShape
                ? t => profileShape(t, rowLow, rowHigh, index)
                : () => [rowLow, rowHigh];
            cutters.push(buildSweptPrism(
                outline,
                from,
                to,
                params.wall,
                profile
            ));
        }
    }
    return cutters;
}

// How far off the flat back a wall cut has to stay once lettering is
// there. Covers the fillet at each end of the chord plus a clear gap, so
// no slot ever comes close enough to a letter to tear the wall between.
const CHORD_CLEARANCE = 2;

// What the wall pattern writes on the back, longest first. A wide plate
// takes the full name; a narrow one takes as much of it as will print.
const WALL_LABELS = ['MEDSTAR OMFS', 'MEDSTAR', 'MSO'];

// Share of each cell the cut fills; the rest is the ridge of material
// left between stacked rows. Packing the rows tighter would let letters
// fit a shorter wall, and it was tried: at 0.8 and 0.85 the ridges grow
// thin enough to tear, so 0.7 is where this stays.
const BAR_FRACTION = 0.7;

// Thinnest bar worth cutting. Measured, not guessed: across a sweep of
// plate widths and line lengths every run at 1.05 mm and above came back
// two-manifold in well under a second, while every run at 0.93 mm and
// below tore the wall and took seconds to do it. One millimeter is the
// line between the two.
const MIN_TEXT_BAR = 1;

/**
 * Smallest band, in millimeters, that still yields printable lettering.
 * Seven rows of cells, each 70 percent bar, plus the edge margins.
 */
export const TEXT_MIN_BAND = Number(
    ((MIN_TEXT_BAR / BAR_FRACTION) * FONT_ROWS + EDGE_MARGIN * 2 + 0.5).toFixed(1)
);

/**
 * How many characters one line can hold on this plate. The flat back is
 * the only wall a line can use, so a wider plate takes a longer line and
 * nothing else changes it.
 */
export function maxLineCharacters(outline, params, band) {
    const usableHeight = band.height - EDGE_MARGIN * 2;
    const usableWidth = outline.chordLength - 6;
    const pitch = MIN_TEXT_BAR / BAR_FRACTION;
    if (usableWidth <= 0 || usableHeight / FONT_ROWS < pitch) return 0;
    const cells = Math.floor(usableWidth / pitch + 1e-6);
    return Math.max(0, Math.floor((cells + 1) / (FONT_COLUMNS + 1)));
}

/**
 * One line of stencil lettering cut into the flat posterior wall,
 * centered, within the vertical slot given.
 */
function buildLineCutters(outline, params, band, text) {
    if (!text) return [];
    const usableHeight = band.height - EDGE_MARGIN * 2;
    // Text stays on the flat posterior chord, clear of both fillets.
    const usableWidth = outline.chordLength - 6;
    if (usableWidth <= 0) return [];

    // Square cells, scaled to whichever of the two limits bites first:
    // the band's height or the run of flat wall the line has to fit in.
    const cellsWide = text.length * (FONT_COLUMNS + 1) - 1;
    const pitch = Math.min(usableHeight / FONT_ROWS, usableWidth / cellsWide);
    const barHeight = pitch * BAR_FRACTION;
    // Bars thinner than this neither print nor drain, so the pattern
    // declines rather than shipping a wall of hairline slots.
    if (barHeight < MIN_TEXT_BAR) return [];

    const rowPitch = pitch;
    const columnPitch = pitch;
    const advance = (FONT_COLUMNS + 1) * columnPitch;
    const totalWidth = text.length * advance - columnPitch;
    // When the width is the binding limit these two are the same number,
    // so compare with a tolerance or rounding alone rejects a line that fits.
    if (totalWidth > usableWidth + 1e-6) return [];

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

                // No snapping here: the chord is a single flat facet, so
                // there is nothing to land on and snapping would collapse
                // these sub-millimeter bars.
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
 * The user's own lettering, up to two lines, stacked and centered on the
 * flat back wall. Two lines split the band between them with a gap, so a
 * second line always shrinks the first rather than colliding with it.
 */
export function buildEngravingCutters(outline, params, band) {
    const lines = [params.textLine1, params.textLine2].filter(Boolean);
    if (!lines.length) return [];

    if (lines.length === 1) {
        return buildLineCutters(outline, params, band, lines[0]);
    }

    const gap = Math.min(1.2, band.height * 0.08);
    const lineHeight = (band.height - gap) / 2;
    const upper = {
        low: band.low + lineHeight + gap,
        high: band.high,
        height: lineHeight
    };
    const lower = {
        low: band.low,
        high: band.low + lineHeight,
        height: lineHeight
    };
    return [
        ...buildLineCutters(outline, params, upper, lines[0]),
        ...buildLineCutters(outline, params, lower, lines[1])
    ];
}

/** Does this base carry any engraved lettering? */
export function hasEngraving(params) {
    return Boolean(params.textLine1 || params.textLine2);
}

/** Bar sizing for the prison-bar pattern, derived from the base itself. */
export function getBarSpec(params) {
    const opening = maxSlotWidth(params);
    return {
        spacing: opening + MIN_LIGAMENT + SNAP_ALLOWANCE,
        // Thinner than the wall on purpose: see buildWallBars.
        diameter: Math.max(1.6, params.wall - 1)
    };
}

export function buildInfillCutterGeometry(params, outlinePoints, { lift = 0, phase = 0, widthScale = 1 } = {}) {
    const engraved = hasEngraving(params);
    if ((!params.infill || params.infill === 'solid') && !engraved) return null;

    const raw = getInfillBand(params);
    // `lift` nudges the whole pattern up by a fraction of a millimeter.
    // Whether a cut lands cleanly depends on how its faces happen to fall
    // against the shell's own vertices, so a caller that gets a torn
    // result can retry a hair higher. Lifting only ever moves cuts away
    // from the clamp band, never into it.
    const band = {
        low: raw.low + lift,
        high: raw.high,
        height: raw.height - lift
    };
    if (band.height < MIN_BAND_HEIGHT) return null;

    const outline = measureOutline(outlinePoints);
    // Every slot pattern is sized from the base itself: as wide as the
    // arch's curvature allows, spaced so the strip of wall left between
    // two cuts still measures at least MIN_LIGAMENT after snapping.
    const width = Math.min(5.5, maxSlotWidth(params)) * widthScale;
    const spacing = width + MIN_LIGAMENT + SNAP_ALLOWANCE;
    let cutters = [];

    if (params.infill === 'bars') {
        // Prison bars: the same wide openings as the window pattern, with a
        // round bar standing in each one. The bars are added back as solids
        // afterwards, so only the openings are cut here.
        const bold = maxSlotWidth(params) * widthScale;
        cutters = buildSlotCutters(outline, params, band, {
            slotWidth: bold,
            pitch: bold + MIN_LIGAMENT + SNAP_ALLOWANCE,
            phase
        });
    } else if (params.infill === 'wide') {
        // As wide as the arch's curvature will take, which is the most
        // material a single course can remove without the cuts around the
        // front of the arch being refused outright.
        const bold = maxSlotWidth(params) * widthScale;
        cutters = buildSlotCutters(outline, params, band, {
            slotWidth: bold,
            pitch: bold + MIN_LIGAMENT + SNAP_ALLOWANCE,
            phase
        });
    } else if (params.infill === 'text') {
        // Letters have a floor they print and cut cleanly at, so a narrow
        // plate has room for a shorter name and nothing else. Take the
        // longest that fits rather than cutting nothing at all.
        for (const label of WALL_LABELS) {
            cutters = buildLineCutters(outline, params, band, label);
            if (cutters.length) break;
        }
    }

    if (engraved) {
        // Lettering and wall cuts must never share ground: two cutters
        // that touch tear the mesh. The lettering owns the flat back, so
        // any slot that would land there is dropped.
        // Test the near edge, not the far one. Every slot sweeps clean
        // through the wall, so its far edge always sits well above the
        // chord and testing that keeps exactly the slots it should drop.
        // The lettering itself is cut later, in its own pass.
        cutters = cutters.filter(cutter => {
            cutter.computeBoundingBox();
            const keep = cutter.boundingBox.min.z > outline.chordZ + CHORD_CLEARANCE;
            if (!keep) cutter.dispose();
            return keep;
        });
    }

    if (!cutters.length) return null;

    try {
        return BufferGeometryUtils.mergeGeometries(cutters, false);
    } finally {
        cutters.forEach(cutter => cutter.dispose());
    }
}
