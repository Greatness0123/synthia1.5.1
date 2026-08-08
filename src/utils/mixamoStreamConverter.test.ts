/**
 * Unit tests for the Mixamo stream converter.
 *
 * Uses the real `walking` stream file at the repo root as the integration
 * fixture (it ships with the project), plus structural invariants derived
 * from the Synthia rig constraints — if any of these break, the converted
 * walk would violate a physics joint limit.
 */

import fs from 'fs';
import path from 'path';
import {
  parseMixamoStream,
  convertMixamoStreamToTimeline,
  type SynthiaWalkArtifact,
} from './mixamoStreamConverter';
import SYNTHIA_RIG_CONSTRAINTS from '../constants/rigConstraints';

function loadWalkingStream(): string {
  const file = path.join(process.cwd(), 'walking2.md');
  return fs.readFileSync(file, 'utf8');
}

describe('parseMixamoStream', () => {
  const stream = parseMixamoStream(loadWalkingStream());

  test('parses header metadata', () => {
    expect(stream.fps).toBe(30);
    expect(stream.durationFrames).toBe(32);
    expect(stream.skeletonRoot).toBe('mixamorig:Hips');
  });

  test('parses 32 frames with correct data length (52 rot nodes + 3 pos = 211 floats)', () => {
    expect(stream.frames).toHaveLength(32);
    for (const frame of stream.frames) {
      expect(frame.data).toHaveLength(211);
    }
  });

  test('frame descriptor maps Hips rot@0 and pos@4', () => {
    const hips = stream.frameDescriptor.find((n) => n.node === 'mixamorig:Hips');
    expect(hips).toBeDefined();
    const rot = stream.frameDescriptor.find(
      (n) => n.node === 'mixamorig:Hips' && n.ch === 'rot'
    );
    const pos = stream.frameDescriptor.find(
      (n) => n.node === 'mixamorig:Hips' && n.ch === 'pos'
    );
    expect(rot?.offset).toBe(0);
    expect(pos?.offset).toBe(4);
  });

  test('every rotation channel matches between frame 0 and frame 31 (seamless pose loop)', () => {
    // The stream data is interleaved: each node's rot quat sits at the descriptor's
    // rot offset (4 floats), with Hips pos embedded at offsets 4..6. Compare only
    // descriptor-designated rot floats so the cumulative pos travel (~177 units)
    // is correctly excluded.
    const rotOffsets = stream.frameDescriptor
      .filter((n) => n.ch === 'rot')
      .map((n) => n.offset);
    expect(rotOffsets).toHaveLength(52);

    const f0 = stream.frames[0].data;
    const f31 = stream.frames[31].data;
    for (const off of rotOffsets) {
      for (let i = 0; i < 4; i++) {
        expect(Math.abs(f0[off + i] - f31[off + i])).toBeLessThan(1e-3);
      }
    }
  });
});

describe('convertMixamoStreamToTimeline', () => {
  let artifact: SynthiaWalkArtifact;
  let stream: ReturnType<typeof parseMixamoStream>;

  beforeAll(() => {
    stream = parseMixamoStream(loadWalkingStream());
    artifact = convertMixamoStreamToTimeline(stream);
  });

  test('produces 32 timeline frames + 1 loop clone (33 entries)', () => {
    expect(artifact.sequence).toHaveLength(33);
    expect(artifact.rootMotion).toHaveLength(33);
  });

  test('every emitted override obeys its synchia rig constraint ranges', () => {
    for (const frame of artifact.sequence) {
      for (const [bone, value] of Object.entries(frame.overrides)) {
        const constraint = SYNTHIA_RIG_CONSTRAINTS[bone];
        expect(constraint).toBeDefined();
        if (typeof value === 'number') {
          expect(value).toBeGreaterThanOrEqual(constraint!.x[0] - 1e-9);
          expect(value).toBeLessThanOrEqual(constraint!.x[1] + 1e-9);
        } else {
          expect(value).toHaveLength(3);
          expect(value[0]).toBeGreaterThanOrEqual(constraint!.x[0] - 1e-9);
          expect(value[0]).toBeLessThanOrEqual(constraint!.x[1] + 1e-9);
          expect(value[1]).toBeGreaterThanOrEqual(constraint!.y[0] - 1e-9);
          expect(value[1]).toBeLessThanOrEqual(constraint!.y[1] + 1e-9);
          expect(value[2]).toBeGreaterThanOrEqual(constraint!.z[0] - 1e-9);
          expect(value[2]).toBeLessThanOrEqual(constraint!.z[1] + 1e-9);
        }
      }
    }
  });

  test('knee overrides are never positive (Synthia negative-flexion convention)', () => {
    for (const frame of artifact.sequence) {
      for (const bone of ['mixamorigleftleg', 'mixamorigrightleg']) {
        const v = frame.overrides[bone];
        expect(typeof v).toBe('number');
        expect(v as number).toBeLessThanOrEqual(0);
        expect(v as number).toBeGreaterThanOrEqual(-2.618);
      }
    }
  });

  test('elbow overrides are non-negative (Synthia positive-flexion)', () => {
    for (const frame of artifact.sequence) {
      for (const bone of ['mixamorigleftforearm', 'mixamorigrightforearm']) {
        const v = frame.overrides[bone];
        expect(typeof v).toBe('number');
        expect(v as number).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test('root motion: loop-seam delta is zeroed; forward speed ≈ 1.7 m/s', () => {
    expect(artifact.rootMotion[0]).toEqual({ dx: 0, dz: 0 });
    expect(artifact.rootMotion[artifact.rootMotion.length - 1]).toEqual({ dx: 0, dz: 0 });
    expect(artifact.metadata.forwardSpeedMps).toBeGreaterThan(1.0);
    expect(artifact.metadata.forwardSpeedMps).toBeLessThan(2.5);
  });

  test('cumulative root z delta ≈ 1.77 m (mixamo 177 units × 0.01)', () => {
    const totalZ = artifact.rootMotion.reduce((sum, d) => sum + Math.abs(d.dz), 0);
    expect(totalZ).toBeGreaterThan(1.5);
    expect(totalZ).toBeLessThan(2.0);
  });

  test('regression: spine and rightupleg frame 0 extractions do not hit clamp rails', () => {
    // Spine Frame 0: Z-rotation (roll, index 2) must be < 0.1 rad
    const spineVal = artifact.sequence[0].overrides['mixamorigspine'];
    console.log("TEST SPINE VAL:", spineVal);
    expect(Array.isArray(spineVal)).toBe(true);
    const spineRoll = (spineVal as [number, number, number])[2];
    expect(Math.abs(spineRoll)).toBeLessThan(0.1);

    // LeftUpLeg Frame 0: X-rotation (pitch, index 0) must be around its real ~28.8 deg (-0.48 rad)
    const leftUpLegVal = artifact.sequence[0].overrides['mixamorigleftupleg'];
    console.log("TEST LEFTUPLEG VAL:", leftUpLegVal);
    expect(Array.isArray(leftUpLegVal)).toBe(true);
    const leftUpLegPitch = (leftUpLegVal as [number, number, number])[0];
    // Assert sign directly (sign-aware assertion instead of Math.abs)
    expect(leftUpLegPitch).toBeLessThan(-0.4);
    expect(leftUpLegPitch).toBeGreaterThanOrEqual(-0.55);

    // RightUpLeg Frame 0: Z-rotation (roll, index 2) must be in a realistic band (not pinned to ±2.094)
    const rightUpLegVal = artifact.sequence[0].overrides['mixamorigrightupleg'];
    console.log("TEST RIGHTUPLEG VAL:", rightUpLegVal);
    expect(Array.isArray(rightUpLegVal)).toBe(true);
    const rightUpLegRoll = (rightUpLegVal as [number, number, number])[2];
    expect(Math.abs(rightUpLegRoll)).toBeLessThan(0.2);
  });

  test('completeness scan: ensure no suspicious rail-pinned values remain across the clip', () => {
    // We scan every frame of the sequence, check every bone's values,
    // and print any value that lands close to a SYNTHIA_RIG_CONSTRAINTS clamp rail.
    // We assert that spine and hip bones NEVER hit any of their clamp rails,
    // confirming that the gimbal-alias bug is fully resolved for them.
    const hitRails: string[] = [];

    for (let i = 0; i < artifact.sequence.length; i++) {
      const frame = artifact.sequence[i];
      for (const [bone, value] of Object.entries(frame.overrides)) {
        const constraint = SYNTHIA_RIG_CONSTRAINTS[bone];
        if (!constraint) continue;

        const checkValue = (val: number, range: [number, number], axis: string) => {
          if (Math.abs(val - range[0]) <= 1e-8 && Math.abs(range[0]) > 0.01) {
            hitRails.push(`${bone}.${axis} MIN (${range[0].toFixed(3)}) at frame ${i}`);
          }
          if (Math.abs(val - range[1]) <= 1e-8 && Math.abs(range[1]) > 0.01) {
            hitRails.push(`${bone}.${axis} MAX (${range[1].toFixed(3)}) at frame ${i}`);
          }
        };

        if (typeof value === 'number') {
          checkValue(value, constraint.x, 'x');
        } else {
          checkValue(value[0], constraint.x, 'x');
          checkValue(value[1], constraint.y, 'y');
          checkValue(value[2], constraint.z, 'z');
        }
      }
    }

    console.log("COMPLETE RAIL SCANS (Total hits):", hitRails.length);
    console.log(hitRails);

    // Spine/Hip bones must never hit clamp rails (which previously they did constantly)
    const criticalBones = ['mixamorigspine', 'mixamorigleftupleg', 'mixamorigrightupleg'];
    const criticalHits = hitRails.filter(hit => criticalBones.some(bone => hit.startsWith(bone)));
    expect(criticalHits).toHaveLength(0);
  });

  test('conversion is deterministic across two runs', () => {
    const second = convertMixamoStreamToTimeline(stream);
    expect(second.sequence).toEqual(artifact.sequence);
    expect(second.rootMotion).toEqual(artifact.rootMotion);
  });
});

describe('artifact generation', () => {
  test('regenerates public/animations/mixamo-walking-synthia.json from the walking stream', () => {
    const outPath = path.join(
      process.cwd(),
      'public',
      'animations',
      'mixamo-walking-synthia.json'
    );
    const artifact = convertMixamoStreamToTimeline(parseMixamoStream(loadWalkingStream()));
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n', 'utf8');

    // Re-read and validate the serialized artifact survives the round-trip.
    const roundTripped = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    expect(roundTripped.sequence).toHaveLength(33);
    expect(roundTripped.rootMotion).toHaveLength(33);
    expect(roundTripped.metadata.forwardSpeedMps).toBeGreaterThan(1.0);
  });
});

describe('edge cases', () => {
  test('throws on non-SJSON input', () => {
    expect(() => parseMixamoStream('this is not a stream\n{"type":"nope"}')).toThrow();
  });

  test('handles a stream with no pos channel (rootMotion fills zeros)', () => {
    const header = JSON.stringify({
      type: 'header',
      format: 'sjson',
      clip: { fps: 30, duration_frames: 1, 'skeleton-root': 'mixamorig:Hips' },
      frame_descriptor: [{ node: 'mixamorig:LeftLeg', ch: 'rot', offset: 0 }],
    });
    const frame = JSON.stringify({
      type: 'frame',
      time: 0,
      index: 0,
      data: [1, 0, 0, 0],
    });
    const artifact = convertMixamoStreamToTimeline(parseMixamoStream(`${header}\n${frame}`));
    expect(artifact.rootMotion[0]).toEqual({ dx: 0, dz: 0 });
  });
});
