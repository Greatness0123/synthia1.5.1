import * as THREE from 'three';
import { PhysicsEngine } from './PhysicsEngine';
import { COMPLETE_MIXAMO_PHYSICS_MATRIX } from '../../constants/physics';
import SYNTHIA_RIG_CONSTRAINTS from '../../constants/rigConstraints';
import { getAnatomicalLimitForBone } from '../../constants/anatomicalLimits';

export const NUM_ENV_SLOTS = 20;

// Define BONE_JOINT_TYPE
type JointType = 'revolute' | 'spherical' | 'fixed';
const BONE_JOINT_TYPE: Record<string, JointType> = {
  'mixamorighips': 'fixed',
  'mixamorigspine': 'spherical',
  'mixamorigspine1': 'spherical',
  'mixamorigspine2': 'spherical',
  'mixamorigneck': 'spherical',
  'mixamorighead': 'spherical',
  'mixamorigleftshoulder': 'spherical',
  'mixamorigrightshoulder': 'spherical',
  'mixamorigleftarm': 'spherical',
  'mixamorigrightarm': 'spherical',
  'mixamorigleftforearm': 'revolute',
  'mixamorigrightforearm': 'revolute',
  'mixamoriglefthand': 'spherical',
  'mixamorigrighthand': 'spherical',
  'mixamorigleftupleg': 'spherical',
  'mixamorigrightupleg': 'spherical',
  'mixamorigleftleg': 'revolute',
  'mixamorigrightleg': 'revolute',
  'mixamorigleftfoot': 'spherical',
  'mixamorigrightfoot': 'spherical',
};

// Add fingers and thumbs
{
  const sides = ['left', 'right'];
  const fingers = ['index', 'middle', 'ring', 'pinky'];
  for (const side of sides) {
    for (const finger of fingers) {
      for (let seg = 1; seg <= 3; seg++) {
        BONE_JOINT_TYPE[`mixamorig${side}hand${finger}${seg}`] = 'spherical';
      }
    }
    for (let seg = 1; seg <= 3; seg++) {
      BONE_JOINT_TYPE[`mixamorig${side}handthumb${seg}`] = 'spherical';
    }
  }
}

const CAPSULE_ATTACH_BONES = new Set([
  'mixamorighips',
]);

function getPhysicsParentName(bone: THREE.Bone, trackedBones: Set<string>): string | null {
  const canonical = bone.name.toLowerCase().replace(/:/g, '');
  if (CAPSULE_ATTACH_BONES.has(canonical)) return null;
  let parent: THREE.Object3D | null = bone.parent;
  while (parent) {
    if (parent instanceof THREE.Bone) {
      const parentCanonical = parent.name.toLowerCase().replace(/:/g, '');
      if (trackedBones.has(parentCanonical)) return parentCanonical;
    }
    parent = parent.parent;
  }
  return null;
}

// Per-bone sign calibration: these bones' baked parent-relative frames carry
// a ~180° bind rotation about Z, which inverts the effective sign of the
// local X hinge axis. Negating the pitch axis restores "+pitch = anatomical
// forward" without touching the converter or requiring artifact regeneration.
const PITCH_AXIS_FLIP: Record<string, string> = {
  'mixamorigleftupleg':  '-1 0 0',
  'mixamorigrightupleg': '-1 0 0',
  'mixamorigspine':      '-1 0 0',
  'mixamorigspine1':     '-1 0 0',
  'mixamorigspine2':     '-1 0 0',
  'mixamorigleftarm':    '-1 0 0',
  'mixamorigrightarm':   '-1 0 0',
};

function getMuJoCoBoneGains(boneName: string): { kp: number; kv: number } {
  const name = boneName.toLowerCase();

  if (name.includes('hand') && (name.includes('index') || name.includes('middle') || name.includes('ring') || name.includes('pinky') || name.includes('thumb'))) {
    return { kp: 5, kv: 1 };
  }
  // Ankles (foot): critical for balance — must push toes down to prevent backward fall
  if (name.includes('foot')) {
    return { kp: 600, kv: 100 };
  }
  // Knees (lower leg): prevent continuous squatting under body weight
  if (name === 'mixamorigleftleg' || name === 'mixamorigrightleg' || name.includes('mixamorigleftleg') || name.includes('mixamorigrightleg')) {
    return { kp: 1000, kv: 180 };
  }
  // Hips (upper leg): upright trunk stabilization
  if (name.includes('upleg')) {
    return { kp: 900, kv: 150 };
  }
  if (name.includes('arm') || name.includes('forearm')) {
    return { kp: 200, kv: 40 };
  }
  // Spine: resist upper body gravitational sag
  if (name.includes('spine')) {
    return { kp: 700, kv: 130 };
  }
  // Head/neck: small inertia — high kp causes bobblehead oscillation; use soft gains
  if (name.includes('neck') || name.includes('head')) {
    return { kp: 80, kv: 25 };
  }
  return { kp: 150, kv: 30 };
}

// Reserved for future bone-length-aware physics tuning
export function _estimateBoneLength(
  boneName: string,
  boneInfo: { bone: THREE.Bone; worldPosition: THREE.Vector3 },
  allBones: Map<string, { bone: THREE.Bone; worldPosition: THREE.Vector3 }>
): number {
  const firstChild = boneInfo.bone.children.find((child): child is THREE.Bone => {
    if (!(child instanceof THREE.Bone)) return false;
    return allBones.has(child.name.toLowerCase().replace(/:/g, ''));
  });
  if (firstChild) {
    const childInfo = allBones.get(firstChild.name.toLowerCase().replace(/:/g, ''));
    if (childInfo) {
      const dx = childInfo.worldPosition.x - boneInfo.worldPosition.x;
      const dy = childInfo.worldPosition.y - boneInfo.worldPosition.y;
      const dz = childInfo.worldPosition.z - boneInfo.worldPosition.z;
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
  }
  const heuristic: Record<string, number> = {
    'mixamorigspine': 0.25, 'mixamorigneck': 0.10, 'mixamorighead': 0.12,
    'mixamorigleftarm': 0.30, 'mixamorigrightarm': 0.30,
    'mixamorigleftforearm': 0.27, 'mixamorigrightforearm': 0.27,
    'mixamoriglefthand': 0.10, 'mixamorigrighthand': 0.10,
    'mixamorigleftupleg': 0.42, 'mixamorigrightupleg': 0.42,
    'mixamorigleftleg': 0.40, 'mixamorigrightleg': 0.40,
    'mixamorigleftfoot': 0.12, 'mixamorigrightfoot': 0.12,
  };
  return heuristic[boneName] ?? 0.15;
}

export function generateAgentSubtreeMJCF(
  boneInfoMap: Map<string, { bone: THREE.Bone; worldPosition: THREE.Vector3 }>,
  capsuleCenterY: number = 0.9,
  pMatrix: any = COMPLETE_MIXAMO_PHYSICS_MATRIX,
  rConstraints: any = SYNTHIA_RIG_CONSTRAINTS,
  prefix: string = ''
): { bodyXml: string; actuatorsXml: string[] } {
  // Set of tracked bone names
  const trackedBones = new Set<string>();
  for (const canonical of boneInfoMap.keys()) {
    if (BONE_JOINT_TYPE[canonical]) {
      trackedBones.add(canonical);
    }
  }

  const actuators: string[] = [];

  // Model root and Capsule properties
  let modelX = 0;
  let modelZ = 0;

  // Use mixamorighips position if available to center the root capsule
  const hipsInfo = boneInfoMap.get('mixamorighips');
  if (hipsInfo) {
    modelX = hipsInfo.worldPosition.x;
    modelZ = hipsInfo.worldPosition.z;
  }

  // Root capsule parameters matching Rapier values
  const modelHeight = 1.8;
  const capsuleRadius = 0.2;
  const capsuleHalfHeight = Math.max(0.1, (modelHeight / 2) - capsuleRadius);

  const capsulePosThree = { x: modelX, y: capsuleCenterY, z: modelZ };
  const capsulePosMj = PhysicsEngine.worldToMuJoCo(capsulePosThree);
  const capsuleQuatMj = [1, 0, 0, 0]; // Identity rotation w,x,y,z

  // Root capsule coordinates and orientation in MuJoCo space
  const rootCapsulePosStr = `${capsulePosMj[0]} ${capsulePosMj[1]} ${capsulePosMj[2]}`;
  const rootCapsuleQuatStr = `${capsuleQuatMj[0]} ${capsuleQuatMj[1]} ${capsuleQuatMj[2]} ${capsuleQuatMj[3]}`;

  // Helper to build recursive bodies
  const buildBodyTreeXML = (boneName: string, parentPos: [number, number, number], parentQuat: [number, number, number, number]): string => {
    const boneInfo = boneInfoMap.get(boneName);
    if (!boneInfo) return '';

    const bone = boneInfo.bone;

    // Get child absolute position/rotation in Three.js space from bind pose if available
    const threePos = (boneInfo as any).bindWorldPosition ? (boneInfo as any).bindWorldPosition.clone() : boneInfo.worldPosition.clone();
    const threeQuat = (boneInfo as any).bindWorldQuaternion ? (boneInfo as any).bindWorldQuaternion.clone() : new THREE.Quaternion();
    if (!(boneInfo as any).bindWorldQuaternion) {
      bone.getWorldQuaternion(threeQuat);
    }

    // Convert child absolute position/rotation to MuJoCo space
    const childPosMj = PhysicsEngine.worldToMuJoCo(threePos);
    const childQuatMj = PhysicsEngine.threeQuatToMuJoCo(threeQuat);

    // Using THREE to calculate relative pos and quat to parent in MuJoCo space
    const pChild = new THREE.Vector3(...childPosMj);
    const qChild = new THREE.Quaternion(childQuatMj[1], childQuatMj[2], childQuatMj[3], childQuatMj[0]);

    const pParent = new THREE.Vector3(...parentPos);
    const qParent = new THREE.Quaternion(parentQuat[1], parentQuat[2], parentQuat[3], parentQuat[0]);

    const pRel = pChild.clone().sub(pParent).applyQuaternion(qParent.clone().invert());
    const qRel = qParent.clone().invert().multiply(qChild);

    const posStr = `${pRel.x} ${pRel.y} ${pRel.z}`;
    const quatStr = `${qRel.w} ${qRel.x} ${qRel.y} ${qRel.z}`;

    // Get bone properties
    const phys = pMatrix[boneName] || { mass: 0.5, principalInertia: { x: 0.005, y: 0.002, z: 0.005 } };

    // Inertial principal moments mapped from Three local to MuJoCo local
    // (Three Y-axis mapped to MuJoCo Z-axis)
    const ixx = phys.principalInertia.x;
    const iyy = phys.principalInertia.z;
    const izz = phys.principalInertia.y;

    let geomXML: string;
    const isFoot = boneName.includes('foot');
    if (isFoot) {
      // Inverse of foot body rotation to guarantee Identity world orientation (100% flat, parallel to floor)
      const qBody = new THREE.Quaternion(childQuatMj[1], childQuatMj[2], childQuatMj[3], childQuatMj[0]);
      const qBodyInv = qBody.clone().invert();
      const qGeomLocalStr = `${qBodyInv.w} ${qBodyInv.x} ${qBodyInv.y} ${qBodyInv.z}`;

      const FOOT_HALF_WIDTH = 0.05;   // 10cm lateral (side-to-side)
      const FOOT_HALF_LENGTH = 0.13;  // 26cm forward-backward (Y)
      const FOOT_HALF_HEIGHT = 0.015; // 3cm vertical thickness (Z)

      // Ankle position in MuJoCo space
      const ankleMj = childPosMj;

      // Position box sole center in world space:
      // X = same as ankle, Y = 6cm forward (-Y in MuJoCo space), Z = 1.5cm (so bottom sits flush at Z = 0 floor level)
      const pWorldOffset = new THREE.Vector3(
        0,
        -0.06,
        FOOT_HALF_HEIGHT - ankleMj[2]
      );

      const pGeomLocal = pWorldOffset.clone().applyQuaternion(qBodyInv);
      const pGeomLocalStr = `${pGeomLocal.x} ${pGeomLocal.y} ${pGeomLocal.z}`;

      // High friction on foot soles: sliding=1.5 torsional=0.1 rolling=0.05 prevents ice-cube drift
      geomXML = `<geom name="${prefix}${boneName}_geom" type="box" size="${FOOT_HALF_WIDTH} ${FOOT_HALF_LENGTH} ${FOOT_HALF_HEIGHT}" pos="${pGeomLocalStr}" quat="${qGeomLocalStr}" friction="3.0 0.5 0.1" contype="2" conaffinity="1" solref="0.002 1" solimp="0.97 0.999 0.9 0.5 2"/>`;
    } else {
      const colRadius = 0.04;
      geomXML = `<geom name="${prefix}${boneName}_geom" type="sphere" size="${colRadius}" pos="0 0 0" contype="2" conaffinity="1" solref="0.004 1" solimp="0.95 0.99 0.9 0.5 2"/>`;
    }

    // Joint declarations
    let jointsXML: string;
    const jointType = BONE_JOINT_TYPE[boneName] || 'spherical';

    // Retrieve constraints and limits
    const constraint = rConstraints[boneName];
    const limits = getAnatomicalLimitForBone(boneName);

    const getSafeRangeStr = (min: number, max: number): string => {
      const sMin = isFinite(min) ? min : -3.14159;
      const sMax = isFinite(max) ? max : 3.14159;
      return `${sMin} ${sMax}`;
    };

    const gains = getMuJoCoBoneGains(boneName);
    const kp = gains.kp;
    const kv = gains.kv;

    const pitchAxis = PITCH_AXIS_FLIP[boneName] ?? '1 0 0';

    if (jointType === 'fixed') {
      jointsXML = '';
    } else if (jointType === 'revolute' || (constraint && constraint.dof === 1)) {
      // Single Hinge Joint (Pitch: axis pitchAxis)
      const min = constraint?.x?.[0] ?? limits?.min ?? -2.618;
      const max = constraint?.x?.[1] ?? limits?.max ?? 0;
      jointsXML = `<joint name="${prefix}${boneName}_pitch" type="hinge" axis="${pitchAxis}" range="${getSafeRangeStr(min, max)}" limited="true"/>`;
      actuators.push(`<position name="act_${prefix}${boneName}_pitch" joint="${prefix}${boneName}_pitch" kp="${kp}" kv="${kv}" ctrlrange="${getSafeRangeStr(min, max)}"/>`);
    } else if (constraint && constraint.dof === 2) {
      // 2-DOF Joint Decomposed into Pitch (pitchAxis) and Roll (0 1 0)
      const minX = constraint.x[0], maxX = constraint.x[1];
      const minZ = constraint.z[0], maxZ = constraint.z[1];
      jointsXML = `
        <joint name="${prefix}${boneName}_pitch" type="hinge" axis="${pitchAxis}" range="${getSafeRangeStr(minX, maxX)}" limited="true"/>
        <joint name="${prefix}${boneName}_roll" type="hinge" axis="0 1 0" range="${getSafeRangeStr(minZ, maxZ)}" limited="true"/>
      `;
      actuators.push(`<position name="act_${prefix}${boneName}_pitch" joint="${prefix}${boneName}_pitch" kp="${kp}" kv="${kv}" ctrlrange="${getSafeRangeStr(minX, maxX)}"/>`);
      actuators.push(`<position name="act_${prefix}${boneName}_roll" joint="${prefix}${boneName}_roll" kp="${kp}" kv="${kv}" ctrlrange="${getSafeRangeStr(minZ, maxZ)}"/>`);
    } else {
      const minX = constraint?.x?.[0] ?? limits?.min ?? -0.785;
      const maxX = constraint?.x?.[1] ?? limits?.max ?? 0.785;
      const minY = constraint?.y?.[0] ?? -0.785;
      const maxY = constraint?.y?.[1] ?? 0.785;
      const minZ = constraint?.z?.[0] ?? -0.785;
      const maxZ = constraint?.z?.[1] ?? 0.785;

      // Head/neck: the Mixamo T-pose bind-pose quaternion bakes a ~90° rotation into the
      // body frame, which physically flips what axis="0 0 1" (yaw) and axis="0 1 0" (roll)
      // actually do in world space. Swapping them here restores the correct semantics:
      //   _yaw  → axis 0 1 0  (body-local Y → world vertical after transform → left/right turn)
      //   _pitch → axis 1 0 0 (body-local X → forward/back tilt, unchanged)
      //   _roll  → axis 0 0 1  (body-local Z → lateral side-tilt)
      const isHeadNeck = boneName.includes('neck') || boneName.includes('head');
      const yawAxis   = isHeadNeck ? '0 1 0' : '0 0 1';
      const rollAxis  = isHeadNeck ? '0 0 1' : '0 1 0';

      // 3-DOF Joint: Yaw -> Pitch -> Roll
      jointsXML = `
        <joint name="${prefix}${boneName}_yaw" type="hinge" axis="${yawAxis}" range="${getSafeRangeStr(minY, maxY)}" limited="true"/>
        <joint name="${prefix}${boneName}_pitch" type="hinge" axis="${pitchAxis}" range="${getSafeRangeStr(minX, maxX)}" limited="true"/>
        <joint name="${prefix}${boneName}_roll" type="hinge" axis="${rollAxis}" range="${getSafeRangeStr(minZ, maxZ)}" limited="true"/>
      `;
      actuators.push(`<position name="act_${prefix}${boneName}_yaw" joint="${prefix}${boneName}_yaw" kp="${kp}" kv="${kv}" ctrlrange="${getSafeRangeStr(minY, maxY)}"/>`);
      actuators.push(`<position name="act_${prefix}${boneName}_pitch" joint="${prefix}${boneName}_pitch" kp="${kp}" kv="${kv}" ctrlrange="${getSafeRangeStr(minX, maxX)}"/>`);
      actuators.push(`<position name="act_${prefix}${boneName}_roll" joint="${prefix}${boneName}_roll" kp="${kp}" kv="${kv}" ctrlrange="${getSafeRangeStr(minZ, maxZ)}"/>`);
    }

    // Recursively build children
    const childBones = Array.from(trackedBones).filter(b => getPhysicsParentName(boneInfoMap.get(b)!.bone, trackedBones) === boneName);
    const childrenXML = childBones.map(cb => buildBodyTreeXML(cb, childPosMj as [number, number, number], childQuatMj as [number, number, number, number])).join('\n');

    return `
      <body name="${prefix}${boneName}" pos="${posStr}" quat="${quatStr}">
        <inertial pos="0 0 0" mass="${phys.mass}" diaginertia="${ixx} ${iyy} ${izz}"/>
        ${jointsXML}
        ${geomXML}
        ${childrenXML}
      </body>
    `.trim();
  };

  // Build the humanoid skeleton tree anchored at mixamorighips under the root capsule
  const hipsBranch = buildBodyTreeXML('mixamorighips', capsulePosMj as [number, number, number], capsuleQuatMj as [number, number, number, number]);

  const bodyXml = `
    <body name="${prefix}root_capsule" pos="${rootCapsulePosStr}" quat="${rootCapsuleQuatStr}">
      <freejoint name="${prefix}root_freejoint"/>
      <geom name="${prefix}root_capsule_geom" type="capsule" size="${capsuleRadius} ${capsuleHalfHeight}" pos="0 0 0" contype="0" conaffinity="0"/>
      <inertial pos="0 0 0" mass="0.001" diaginertia="5.0 3.0 5.0"/>

      ${hipsBranch}
      <geom name="${prefix}torso_collider" type="sphere" size="0.12" pos="0 0 0" contype="2" conaffinity="1" solref="0.004 1" solimp="0.95 0.99 0.9 0.5 2"/>
    </body>
  `.trim();

  return { bodyXml, actuatorsXml: actuators };
}

export function injectAssetsAndBodies(baseXml: string, assets: string[], bodies: string[]): string {
  let xml = baseXml;

  if (assets.length > 0) {
    // Check if <asset> exists
    const assetStartIdx = xml.indexOf('<asset>');
    const assetEndIdx = xml.indexOf('</asset>');
    if (assetStartIdx >= 0 && assetEndIdx >= 0) {
      // Append inside existing <asset>
      const insideAsset = xml.slice(assetStartIdx + 7, assetEndIdx);
      const newInside = insideAsset + '\n      ' + assets.join('\n      ');
      xml = xml.slice(0, assetStartIdx + 7) + newInside + xml.slice(assetEndIdx);
    } else {
      // Create new <asset> block
      const newAssetBlock = `\n  <asset>\n    ${assets.join('\n    ')}\n  </asset>`;
      // Insert after compiler tag or before worldbody tag
      const compilerEndIdx = xml.indexOf('/>', xml.indexOf('<compiler'));
      if (compilerEndIdx >= 0) {
        xml = xml.slice(0, compilerEndIdx + 2) + newAssetBlock + xml.slice(compilerEndIdx + 2);
      } else {
        const mujocoTagEnd = xml.indexOf('>');
        if (mujocoTagEnd >= 0) {
          xml = xml.slice(0, mujocoTagEnd + 1) + newAssetBlock + xml.slice(mujocoTagEnd + 1);
        } else {
          xml = newAssetBlock + xml;
        }
      }
    }
  }

  if (bodies.length > 0) {
    // Insert bodies inside <worldbody> before </worldbody>
    const worldbodyEndIdx = xml.lastIndexOf('</worldbody>');
    if (worldbodyEndIdx >= 0) {
      xml = xml.slice(0, worldbodyEndIdx) + '\n    ' + bodies.join('\n    ') + '\n  ' + xml.slice(worldbodyEndIdx);
    }
  }

  return xml;
}

export function generateHumanoidMJCF(
  boneInfoMap: Map<string, { bone: THREE.Bone; worldPosition: THREE.Vector3 }>,
  _skeletonOrBones: any,
  capsuleCenterYOrPhysicsMatrix?: any,
  modelRootOrRigConstraints?: any,
  physicsMatrix?: any,
  rigConstraints?: any,
  prefix: string = ''
): string {
  let capsuleCenterY = 0.9;
  let pMatrix = COMPLETE_MIXAMO_PHYSICS_MATRIX;
  let rConstraints = SYNTHIA_RIG_CONSTRAINTS;

  if (typeof capsuleCenterYOrPhysicsMatrix === 'number') {
    capsuleCenterY = capsuleCenterYOrPhysicsMatrix;
    if (physicsMatrix) pMatrix = physicsMatrix;
    if (rigConstraints) rConstraints = rigConstraints;
  } else {
    if (capsuleCenterYOrPhysicsMatrix) pMatrix = capsuleCenterYOrPhysicsMatrix;
    if (modelRootOrRigConstraints) rConstraints = modelRootOrRigConstraints;
  }

  const { bodyXml, actuatorsXml } = generateAgentSubtreeMJCF(boneInfoMap, capsuleCenterY, pMatrix, rConstraints, prefix);

  // Generate pre-allocated slot bodies (env_slot_0 to env_slot_N)
  const slotBodies: string[] = [];
  for (let i = 0; i < NUM_ENV_SLOTS; i++) {
    slotBodies.push(`
    <body name="env_slot_${i}" pos="0 0 -10">
      <freejoint name="env_slot_${i}_joint"/>
      <inertial pos="0 0 0" mass="1" diaginertia="0.1 0.1 0.1"/>
      <geom name="env_slot_${i}_sphere" type="sphere" size="0.001" contype="0" conaffinity="0"/>
      <geom name="env_slot_${i}_box" type="box" size="0.001 0.001 0.001" contype="0" conaffinity="0"/>
      <geom name="env_slot_${i}_cylinder" type="cylinder" size="0.001 0.001" contype="0" conaffinity="0"/>
      <geom name="env_slot_${i}_capsule" type="capsule" size="0.001 0.001" contype="0" conaffinity="0"/>
    </body>`);
  }

  // Generate 88 piano keys
  const pianoGeoms: string[] = [];
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  for (let i = 0; i < 88; i++) {
    const isBlack = [1, 3, 6, 8, 10].includes((i + 9) % 12);
    const width = isBlack ? 0.012 : 0.022;
    const height = isBlack ? 0.022 : 0.015;
    const depth = isBlack ? 0.08 : 0.12;

    const xOffset = (i - 44) * 0.023;
    const yOffset = isBlack ? 0.015 : 0;
    const zOffset = isBlack ? -0.02 : 0;

    const midiNote = 21 + i;
    const octave = Math.floor(midiNote / 12) - 1;
    const noteIndex = midiNote % 12;
    const noteName = NOTE_NAMES[noteIndex] + octave;

    // Map relative positions: x_mj = xOffset, y_mj = zOffset, z_mj = -yOffset
    pianoGeoms.push(`      <geom name="piano_${noteName}" type="box" size="${width / 2} ${depth / 2} ${height / 2}" pos="${xOffset} ${zOffset} ${-yOffset}" contype="0" conaffinity="0"/>`);
  }

  const pianoBody = `
    <body name="piano_body" pos="0 0 -30">
      <freejoint name="piano_joint"/>
      <inertial pos="0 0 0" mass="50" diaginertia="5.0 5.0 5.0"/>
${pianoGeoms.join('\n')}
    </body>
  `;

  // Return the complete MJCF XML
  const xml = `
<mujoco model="synthia_humanoid">
  <compiler angle="radian" coordinate="local" inertiafromgeom="false"/>
  <option gravity="0 0 -9.81" timestep="0.002" iterations="200" integrator="implicitfast"/>
  <default>
    <geom friction="2.0 0.5 0.1"/>
  </default>
  <worldbody>
    <light directional="true" pos="0 0 5" dir="0 0 -1"/>
    <geom name="floor" type="plane" size="100 100 0.1" rgba="0.8 0.9 0.8 1" friction="2.0 0.5 0.1" contype="1" conaffinity="2" solref="0.004 1" solimp="0.95 0.99 0.9 0.5 2"/>

    ${bodyXml}

    ${slotBodies.join('\n')}

    ${pianoBody}
  </worldbody>

  <actuator>
    ${actuatorsXml.join('\n    ')}
  </actuator>
</mujoco>
  `.trim();

  return xml;
}

export function generateCombinedMultiAgentMJCF(
  agents: Array<{
    prefix: string;
    boneInfoMap: Map<string, { bone: THREE.Bone; worldPosition: THREE.Vector3 }>;
    capsuleCenterY: number;
    physicsMatrix?: any;
    rigConstraints?: any;
  }>,
  customMeshesSpec: any[] = []
): string {
  const bodiesXmlList: string[] = [];
  const actuatorsXmlList: string[] = [];

  for (const agent of agents) {
    const pMatrix = agent.physicsMatrix || COMPLETE_MIXAMO_PHYSICS_MATRIX;
    const rConstraints = agent.rigConstraints || SYNTHIA_RIG_CONSTRAINTS;
    const { bodyXml, actuatorsXml } = generateAgentSubtreeMJCF(
      agent.boneInfoMap,
      agent.capsuleCenterY,
      pMatrix,
      rConstraints,
      agent.prefix
    );
    bodiesXmlList.push(bodyXml);
    actuatorsXmlList.push(...actuatorsXml);
  }

  // Generate pre-allocated slot bodies (env_slot_0 to env_slot_N)
  const slotBodies: string[] = [];
  for (let i = 0; i < NUM_ENV_SLOTS; i++) {
    slotBodies.push(`
    <body name="env_slot_${i}" pos="0 0 -10">
      <freejoint name="env_slot_${i}_joint"/>
      <inertial pos="0 0 0" mass="1" diaginertia="0.1 0.1 0.1"/>
      <geom name="env_slot_${i}_sphere" type="sphere" size="0.001" contype="0" conaffinity="0"/>
      <geom name="env_slot_${i}_box" type="box" size="0.001 0.001 0.001" contype="0" conaffinity="0"/>
      <geom name="env_slot_${i}_cylinder" type="cylinder" size="0.001 0.001" contype="0" conaffinity="0"/>
      <geom name="env_slot_${i}_capsule" type="capsule" size="0.001 0.001" contype="0" conaffinity="0"/>
    </body>`);
  }

  // Generate 88 piano keys
  const pianoGeoms: string[] = [];
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  for (let i = 0; i < 88; i++) {
    const isBlack = [1, 3, 6, 8, 10].includes((i + 9) % 12);
    const width = isBlack ? 0.012 : 0.022;
    const height = isBlack ? 0.022 : 0.015;
    const depth = isBlack ? 0.08 : 0.12;

    const xOffset = (i - 44) * 0.023;
    const yOffset = isBlack ? 0.015 : 0;
    const zOffset = isBlack ? -0.02 : 0;

    const midiNote = 21 + i;
    const octave = Math.floor(midiNote / 12) - 1;
    const noteIndex = midiNote % 12;
    const noteName = NOTE_NAMES[noteIndex] + octave;

    // Map relative positions: x_mj = xOffset, y_mj = zOffset, z_mj = -yOffset
    pianoGeoms.push(`      <geom name="piano_${noteName}" type="box" size="${width / 2} ${depth / 2} ${height / 2}" pos="${xOffset} ${zOffset} ${-yOffset}" contype="0" conaffinity="0"/>`);
  }

  const pianoBody = `
    <body name="piano_body" pos="0 0 -30">
      <freejoint name="piano_joint"/>
      <inertial pos="0 0 0" mass="50" diaginertia="5.0 5.0 5.0"/>
${pianoGeoms.join('\n')}
    </body>
  `;

  const xml = `
<mujoco model="synthia_humanoid">
  <compiler angle="radian" coordinate="local" inertiafromgeom="false"/>
  <option gravity="0 0 -9.81" timestep="0.002" iterations="200" integrator="implicitfast"/>
  <default>
    <geom friction="2.0 0.5 0.1"/>
  </default>
  <worldbody>
    <light directional="true" pos="0 0 5" dir="0 0 -1"/>
    <geom name="floor" type="plane" size="100 100 0.1" rgba="0.8 0.9 0.8 1" friction="2.0 0.5 0.1" contype="1" conaffinity="2" solref="0.004 1" solimp="0.95 0.99 0.9 0.5 2"/>

    ${bodiesXmlList.join('\n\n')}

    ${slotBodies.join('\n')}

    ${pianoBody}
  </worldbody>

  <actuator>
    ${actuatorsXmlList.join('\n    ')}
  </actuator>
</mujoco>
  `.trim();

  // Map custom meshes specs to separate arrays
  const customAssets: string[] = [];
  const customBodies: string[] = [];

  for (const spec of customMeshesSpec) {
    if (spec.options?.skipCollision) {
      continue;
    }

    const posMj = PhysicsEngine.worldToMuJoCo(spec.position);
    const quatMj = spec.quaternion
      ? PhysicsEngine.threeQuatToMuJoCo(spec.quaternion)
      : [1, 0, 0, 0];

    const hasHulls = spec.processed && spec.processed.hulls && spec.processed.hulls.length > 0;

    if (hasHulls) {
      const geomsXml: string[] = [];
      spec.processed!.hulls.forEach((hull: { positions: number[]; indices: number[] }, i: number) => {
        customAssets.push(`<mesh name="hull_${spec.id}_${i}" vertex="${hull.positions.join(' ')}" face="${hull.indices.join(' ')}"/>`);
        if (spec.options?.isTerrain) {
          geomsXml.push(`<geom name="custom_geom_${spec.id}_${i}" type="mesh" mesh="hull_${spec.id}_${i}" contype="1" conaffinity="2"/>`);
        } else {
          geomsXml.push(`<geom name="custom_geom_${spec.id}_${i}" type="mesh" mesh="hull_${spec.id}_${i}" contype="2" conaffinity="3"/>`);
        }
      });

      if (spec.options?.isTerrain) {
        customBodies.push(`
    <body name="custom_${spec.id}" pos="${posMj[0]} ${posMj[1]} ${posMj[2]}" quat="${quatMj[0]} ${quatMj[1]} ${quatMj[2]} ${quatMj[3]}">
      ${geomsXml.join('\n      ')}
    </body>`);
      } else {
        customBodies.push(`
    <body name="custom_${spec.id}" pos="${posMj[0]} ${posMj[1]} ${posMj[2]}" quat="${quatMj[0]} ${quatMj[1]} ${quatMj[2]} ${quatMj[3]}">
      <freejoint name="custom_${spec.id}_joint"/>
      ${geomsXml.join('\n      ')}
      <inertial pos="0 0 0" mass="${spec.preset.mass}" diaginertia="0.1 0.1 0.1"/>
    </body>`);
      }
    } else {
      const verticesStr = Array.from(spec.vertices).join(' ');
      const facesStr = Array.from(spec.indices).join(' ');

      customAssets.push(`<mesh name="mesh_${spec.id}" vertex="${verticesStr}" face="${facesStr}"/>`);

      if (spec.options?.isTerrain) {
        customBodies.push(`
    <body name="custom_${spec.id}" pos="${posMj[0]} ${posMj[1]} ${posMj[2]}" quat="${quatMj[0]} ${quatMj[1]} ${quatMj[2]} ${quatMj[3]}">
      <geom name="custom_geom_${spec.id}" type="mesh" mesh="mesh_${spec.id}" contype="1" conaffinity="2"/>
    </body>`);
      } else {
        customBodies.push(`
    <body name="custom_${spec.id}" pos="${posMj[0]} ${posMj[1]} ${posMj[2]}" quat="${quatMj[0]} ${quatMj[1]} ${quatMj[2]} ${quatMj[3]}">
      <freejoint name="custom_${spec.id}_joint"/>
      <geom name="custom_geom_${spec.id}" type="mesh" mesh="mesh_${spec.id}" contype="2" conaffinity="3"/>
      <inertial pos="0 0 0" mass="${spec.preset.mass}" diaginertia="0.1 0.1 0.1"/>
    </body>`);
      }
    }
  }

  return injectAssetsAndBodies(xml, customAssets, customBodies);
}
