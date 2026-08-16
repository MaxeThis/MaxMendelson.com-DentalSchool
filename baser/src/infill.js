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

    // Returned as separate bars, not one merged solid. Each goes into the
    // wall on its own so a bar that will not union cleanly costs one bar
    // rather than the whole plate.
    return parts;
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

// What the wall pattern writes on the back.
const WALL_LABEL = 'MEDSTAR OMFS';

// The operator's own lettering is a shallow recess in the outer face, not
// a slot through the wall. That is what lets it sit low on the base, at a
// readable label size, without opening the clamp zone or fighting the
// wall pattern for room.
const ENGRAVE_DEPTH = 0.6;
// Tallest a capital is allowed to be. A label, not a headline.
const ENGRAVE_CAP_HEIGHT = 4.2;
// How far the lowest line sits above the ground, so the first printed
// layer is never a letter.
const ENGRAVE_FLOOR = 1.5;
const ENGRAVE_LINE_GAP = 1;
// Clearance kept under the wall pattern, so a letter and a slot never
// meet on the same stretch of wall.
const ENGRAVE_HEADROOM = 0.6;
// A recess into solid material tolerates far finer strokes than a slot
// cut through a thin wall, which is why this is well under MIN_TEXT_BAR.
const MIN_ENGRAVE_BAR = 0.25;
// Narrowest a column may be, in millimeters. A stroke is 0.7 of its cell,
// and a resin printer holds about 0.3 mm, so this is where a stroke stops
// being a stroke. It is a printing limit, not a boolean one: columns are
// never what tears the wall, rows are. Set at 0.5 it silently outlawed
// every capital under 3.5 mm, which is exactly the size a default clamp
// band asks for once two lines have to share it.
const MIN_COLUMN_PITCH = 0.43;

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
export function maxLineCharacters(outline) {
    const usableWidth = outline.chordLength - 6;
    if (usableWidth <= 0) return 0;
    const cells = Math.floor(usableWidth / MIN_COLUMN_PITCH + 1e-6);
    return Math.max(0, Math.floor((cells + 1) / (FONT_COLUMNS + 1)));
}

/**
 * Break a glyph into as few rectangles as will cover it, merging downward
 * as well as across.
 *
 * Cutting one box per row-run leaves a vertical stroke as a stack of
 * seven separate crumbs: seven times the cutters, each of them smaller
 * than this boolean reliably handles, and a stroke that reads as a dotted
 * line. Merged, the same stroke is a single tall box.
 */
function glyphRectangles(rows) {
    const covered = Array.from(
        { length: FONT_ROWS },
        () => new Array(FONT_COLUMNS).fill(false)
    );
    const lit = (row, column) => Boolean(
        rows[row] & (1 << (FONT_COLUMNS - 1 - column))
    );
    const free = (row, column) => lit(row, column) && !covered[row][column];
    const rectangles = [];

    for (let row = 0; row < FONT_ROWS; row += 1) {
        for (let column = 0; column < FONT_COLUMNS; column += 1) {
            if (!free(row, column)) continue;

            let width = 1;
            while (column + width < FONT_COLUMNS && free(row, column + width)) {
                width += 1;
            }

            let height = 1;
            while (row + height < FONT_ROWS) {
                let whole = true;
                for (let step = 0; step < width; step += 1) {
                    if (!free(row + height, column + step)) {
                        whole = false;
                        break;
                    }
                }
                if (!whole) break;
                height += 1;
            }

            for (let r = row; r < row + height; r += 1) {
                for (let c = column; c < column + width; c += 1) covered[r][c] = true;
            }
            rectangles.push({ row, column, width, height });
        }
    }
    return rectangles;
}

/**
 * One line of stencil lettering cut into the flat posterior wall,
 * centered, within the vertical slot given.
 */
function buildLineCutters(outline, params, band, text, options = {}) {
    if (!text) return [];
    const {
        // A fixed capital height, or null to fill whatever band it is given.
        capHeight = null,
        // How far into the wall to cut. Null cuts clean through.
        depth = null,
        minBar = MIN_TEXT_BAR
    } = options;

    const usableHeight = band.height - EDGE_MARGIN * 2;
    // Text stays on the flat posterior chord, clear of both fillets.
    const usableWidth = outline.chordLength - 6;
    if (usableWidth <= 0) return [];

    const capacity = capHeight ?? usableHeight;
    if (capacity > usableHeight + 1e-6) return [];
    const rowPitch = capacity / FONT_ROWS;
    const barHeight = rowPitch * BAR_FRACTION;
    // Bars thinner than this neither print nor drain, so the line declines
    // rather than shipping a wall of hairline slots.
    if (barHeight < minBar) return [];

    // Columns are sized on their own, and condensed when a long line has
    // to fit a narrow plate. Tying them to the rows, as this once did,
    // meant a long line thinned its own bars until they tore, which is
    // why the wall used to fall back to a shortened name.
    const cellsWide = text.length * (FONT_COLUMNS + 1) - 1;
    const columnPitch = Math.min(rowPitch, usableWidth / cellsWide);
    if (columnPitch < MIN_COLUMN_PITCH) return [];

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
    // A prism is measured from PIERCE_OVERSHOOT outside the surface, so a
    // recess has to span that standoff before it bites. Passing the bare
    // depth leaves the cutter hovering clear of the wall, cutting nothing.
    const innerDepth = depth === null
        ? params.wall + PIERCE_OVERSHOOT * TEXT_DEPTH_FACTOR
        : PIERCE_OVERSHOOT + depth;
    const cutters = [];


    // The vertical gap left between two separate rectangles. A stroke that
    // runs on through several rows keeps no gap at all, because it is now
    // cut as one piece.
    const rowGap = rowPitch - barHeight;

    for (let character = 0; character < text.length; character += 1) {
        const glyphArc = rightArc - character * advance;

        for (const rect of glyphRectangles(FONT[text[character]] ?? FONT[' '])) {
            // No snapping here: the chord is a single flat facet, so there
            // is nothing to land on and snapping would collapse these
            // sub-millimeter bars.
            const from = glyphArc - (rect.column + rect.width) * columnPitch + inset;
            const to = glyphArc - rect.column * columnPitch - inset;
            // Row 0 is the top of the glyph.
            const top = bottom
                + (FONT_ROWS - rect.row) * rowPitch
                - rowGap / 2;
            const low = bottom
                + (FONT_ROWS - rect.row - rect.height) * rowPitch
                + rowGap / 2;

            cutters.push(buildSweptPrism(
                outline,
                from,
                to,
                params.wall,
                () => [low, top],
                innerDepth
            ));
        }
    }

    return cutters;
}

/**
 * The user's own lettering, up to two lines, stacked and centered on the
 * flat back wall. Two lines split the band between them with a gap, so a
 * second line always shrinks the first rather than colliding with it.
 */
export function buildEngravingCutters(outline, params) {
    const lines = [params.textLine1, params.textLine2].filter(Boolean);
    if (!lines.length) return [];

    const cap = engravingCapHeight(params, lines.length);
    if (!cap) return [];

    // Lines stack upward from the floor with the first on top, so adding a
    // second line lifts the first rather than colliding with it.
    const cutters = [];
    lines.slice().reverse().forEach((text, index) => {
        const low = ENGRAVE_FLOOR + index * (cap + ENGRAVE_LINE_GAP);
        cutters.push(...buildLineCutters(
            outline,
            params,
            // The builder centers a line inside the band it is handed, so
            // the band is padded by exactly the margin it will take back.
            {
                low: low - EDGE_MARGIN,
                high: low + cap + EDGE_MARGIN,
                height: cap + EDGE_MARGIN * 2
            },
            text,
            { capHeight: cap, depth: ENGRAVE_DEPTH, minBar: MIN_ENGRAVE_BAR }
        ));
    });
    return cutters;
}

/**
 * How tall a capital can be on this plate, or 0 if lettering will not fit.
 *
 * Lettering lives on the solid clamp band and the wall pattern lives above
 * it. That line is what keeps the two apart: before this, the pattern's
 * band began at the clamp band while two engraved lines reached past it,
 * so on every clamp band up to the default the two fought for the same
 * stretch of wall and strokes were quietly dropped to keep the mesh shut.
 */
export function engravingCapHeight(params, lineCount = 1) {
    const lines = Math.max(1, lineCount);
    const room = Math.min(params.clampBand, params.height - params.wall)
        - ENGRAVE_FLOOR
        - ENGRAVE_HEADROOM
        - (lines - 1) * ENGRAVE_LINE_GAP;
    if (room <= 0) return 0;
    const cap = Math.min(ENGRAVE_CAP_HEIGHT, room / lines);
    // Too fine to print or to cut cleanly is the same as not fitting.
    return cap * BAR_FRACTION / FONT_ROWS >= MIN_ENGRAVE_BAR ? cap : 0;
}

/**
 * The wall pattern that writes the clinic's name through the wall, as a
 * list of separate strokes rather than one merged cutter.
 */
export function buildWallLabelCutters(outline, params) {
    if (params.infill !== 'text') return [];
    const band = getInfillBand(params);
    if (band.height < MIN_BAND_HEIGHT) return [];
    return buildLineCutters(outline, params, band, WALL_LABEL);
}

/** The smallest clamp band that will hold this many lines, in mm. */
export function engravingBandNeeded(lineCount) {
    const lines = Math.max(1, lineCount);
    // The smallest capital that still cuts and prints, not the tallest.
    const smallest = (MIN_ENGRAVE_BAR / BAR_FRACTION) * FONT_ROWS;
    return Number((ENGRAVE_FLOOR
        + lines * smallest
        + (lines - 1) * ENGRAVE_LINE_GAP
        + ENGRAVE_HEADROOM).toFixed(1));
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
        // Thinner than the wall on purpose: see buildWallBars. The floor
        // used to be a flat 1.6 mm, which on a thin wall came out equal to
        // the wall itself. A bar that touches both faces is tangent to
        // them, and tangency is what tears this boolean, so the bar is
        // held clear of both faces at every wall thickness.
        diameter: Math.min(
            Math.max(1.6, params.wall - 1),
            params.wall * 0.6
        )
    };
}

export function buildInfillCutterGeometry(params, outlinePoints, attempt = {}) {
    const pieces = buildInfillCutterPieces(params, outlinePoints, attempt);
    if (!pieces.length) return null;
    try {
        return BufferGeometryUtils.mergeGeometries(pieces, false);
    } finally {
        pieces.forEach(piece => piece.dispose());
    }
}

/**
 * The wall pattern as separate cuts. Each goes into the wall on its own,
 * so one awkward slot costs one slot rather than the whole plate.
 */
export function buildInfillCutterPieces(params, outlinePoints, { lift = 0, phase = 0, widthScale = 1 } = {}) {
    if (!params.infill || params.infill === 'solid') return [];

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
    if (band.height < MIN_BAND_HEIGHT) return [];

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
    }
    // The lettered wall is not built here. Letters are many small cuts,
    // and small cuts go in one at a time, through the same path as the
    // operator's own lines.

    // Lettering and wall cuts must never share ground: two cuts that meet
    // tear the mesh between them. The flat back belongs to the lettering,
    // so any slot that would land there is dropped. Test the near edge,
    // not the far one: every slot sweeps clean through the wall, so its
    // far edge always sits well above the chord.
    if (hasEngraving(params) || params.infill === 'text') {
        cutters = cutters.filter(cutter => {
            cutter.computeBoundingBox();
            const keep = cutter.boundingBox.min.z > outline.chordZ + CHORD_CLEARANCE;
            if (!keep) cutter.dispose();
            return keep;
        });
    }

    return cutters;
}
