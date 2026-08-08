/// <reference types="jest" />

import * as THREE from 'three';
import { generateHumanoidMJCF } from '../MJCFHumanoidTemplate';
import { PhysicsEngine } from '../PhysicsEngine';

declare function describe(name: string, fn: () => void): void;
declare function beforeEach(fn: () => void): void;
declare function afterEach(fn: () => void): void;
declare function test(name: string, fn: () => void): void;
declare function expect(actual: unknown): {
  toBe(expected: unknown): void;
  toBeTruthy(): void;
  toBeLessThanOrEqual(expected: number): void;
  toBeGreaterThan(expected: number): void;
  toBeGreaterThanOrEqual(expected: number): void;
};

describe('MJCFHumanoidTemplate', () => {
  let engine: PhysicsEngine;

  beforeEach(() => {
    engine = new PhysicsEngine();
  });

  afterEach(() => {
    engine.cleanup();
  });

  test('generateHumanoidMJCF generates valid loadable XML', async () => {
    await engine.init();

    // Create a mock skeleton structure
    const boneInfoMap = new Map<string, { bone: THREE.Bone; worldPosition: THREE.Vector3 }>();

    const pelvis = new THREE.Bone();
    pelvis.name = 'mixamorighips';
    boneInfoMap.set('mixamorighips', { bone: pelvis, worldPosition: new THREE.Vector3(0, 0.9, 0) });

    const spine = new THREE.Bone();
    spine.name = 'mixamorigspine';
    pelvis.add(spine);
    boneInfoMap.set('mixamorigspine', { bone: spine, worldPosition: new THREE.Vector3(0, 1.1, 0) });

    const spine1 = new THREE.Bone();
    spine1.name = 'mixamorigspine1';
    spine.add(spine1);
    boneInfoMap.set('mixamorigspine1', { bone: spine1, worldPosition: new THREE.Vector3(0, 1.3, 0) });

    const leftupleg = new THREE.Bone();
    leftupleg.name = 'mixamorigleftupleg';
    pelvis.add(leftupleg);
    boneInfoMap.set('mixamorigleftupleg', { bone: leftupleg, worldPosition: new THREE.Vector3(-0.12, 0.8, 0) });

    const leftleg = new THREE.Bone();
    leftleg.name = 'mixamorigleftleg';
    leftupleg.add(leftleg);
    boneInfoMap.set('mixamorigleftleg', { bone: leftleg, worldPosition: new THREE.Vector3(-0.12, 0.4, 0) });

    const leftfoot = new THREE.Bone();
    leftfoot.name = 'mixamorigleftfoot';
    leftleg.add(leftfoot);
    boneInfoMap.set('mixamorigleftfoot', { bone: leftfoot, worldPosition: new THREE.Vector3(-0.12, 0.05, 0.04) });

    // Generate XML
    const xml = generateHumanoidMJCF(boneInfoMap, [], 0.9, pelvis);

    // Verify it contains basic XML elements
    expect(xml).toBeTruthy();
    expect(xml.includes('<mujoco model="synthia_humanoid">')).toBe(true);
    expect(xml.includes('<compiler angle="radian" coordinate="local" inertiafromgeom="false"/>')).toBe(true);
    expect(xml.includes('<body name="root_capsule"')).toBe(true);
    expect(xml.includes('<freejoint name="root_freejoint"/>')).toBe(true);

    // Verify joint decomposition structure
    // Spine should be 3-DOF spherical decomposed into yaw, pitch, roll hinges
    expect(xml.includes('name="mixamorigspine_yaw" type="hinge" axis="0 0 1"')).toBe(true);
    expect(xml.includes('name="mixamorigspine_pitch" type="hinge" axis="-1 0 0"')).toBe(true);
    expect(xml.includes('name="mixamorigspine_roll" type="hinge" axis="0 1 0"')).toBe(true);

    // Left leg should be 1-DOF revolute/hinge (pitch) - this one is not flipped, remains 1 0 0
    expect(xml.includes('name="mixamorigleftleg_pitch" type="hinge" axis="1 0 0"')).toBe(true);

    // Left foot should be 3-DOF decomposed (by default, if no 2-DOF restriction, or according to BONE_JOINT_TYPE) - not flipped, remains 1 0 0
    expect(xml.includes('name="mixamorigleftfoot_pitch" type="hinge" axis="1 0 0"')).toBe(true);

    // Check capsule and box geom mapping
    expect(xml.includes('type="capsule"')).toBe(true);
    expect(xml.includes('type="box"')).toBe(true);

    // Check if the generated MJCF XML compiles and loads cleanly in MuJoCo WASM
    let loadFailed = false;
    try {
      engine.loadMJCFModel(xml);
      engine.setReady(true);
    } catch (err) {
      loadFailed = true;
      console.error(err);
    }
    expect(loadFailed).toBe(false);
    expect(engine.isBroken).toBe(false);
  });

  test('generateCombinedMultiAgentMJCF generates valid loadable multi-agent XML', async () => {
    await engine.init();

    // Create a mock skeleton structure
    const boneInfoMap = new Map<string, { bone: THREE.Bone; worldPosition: THREE.Vector3 }>();

    const pelvis = new THREE.Bone();
    pelvis.name = 'mixamorighips';
    boneInfoMap.set('mixamorighips', { bone: pelvis, worldPosition: new THREE.Vector3(0, 0.9, 0) });

    const spine = new THREE.Bone();
    spine.name = 'mixamorigspine';
    pelvis.add(spine);
    boneInfoMap.set('mixamorigspine', { bone: spine, worldPosition: new THREE.Vector3(0, 1.1, 0) });

    const xml = generateHumanoidMJCF(boneInfoMap, [], 0.9, pelvis);
    expect(xml).toBeTruthy();

    const importTemplate = await import('../MJCFHumanoidTemplate');
    if ('generateCombinedMultiAgentMJCF' in importTemplate) {
      const combinedXml = importTemplate.generateCombinedMultiAgentMJCF([
        { prefix: 'agent_0_', boneInfoMap, capsuleCenterY: 0.9 },
        { prefix: 'agent_1_', boneInfoMap, capsuleCenterY: 0.9 }
      ]);

      expect(combinedXml).toBeTruthy();
      expect(combinedXml.includes('body name="agent_0_root_capsule"')).toBe(true);
      expect(combinedXml.includes('body name="agent_1_root_capsule"')).toBe(true);
      expect(combinedXml.includes('joint name="agent_0_mixamorigspine_yaw"')).toBe(true);
      expect(combinedXml.includes('joint name="agent_1_mixamorigspine_yaw"')).toBe(true);
      expect(combinedXml.includes('position name="act_agent_0_mixamorigspine_yaw"')).toBe(true);
      expect(combinedXml.includes('position name="act_agent_1_mixamorigspine_yaw"')).toBe(true);

      let loadFailed = false;
      try {
        engine.loadMJCFModel(combinedXml);
        engine.setReady(true);
      } catch (err) {
        loadFailed = true;
        console.error(err);
      }
      expect(loadFailed).toBe(false);
      expect(engine.isBroken).toBe(false);
    }
  });
});
