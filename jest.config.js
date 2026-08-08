/** @type {import('ts-jest').JestConfigWithTsJest} **/
export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: [
    '**/src/utils/mixamoStreamConverter.test.ts',
    '**/src/world/engine/__tests__/PhysicsEngine.test.ts',
    '**/src/world/engine/__tests__/MJCFHumanoidTemplate.test.ts',
    '**/src/world/engine/__tests__/CollisionAdapter.test.ts',
    '**/src/world/engine/__tests__/ObjectManager.test.ts',
    '**/src/world/engine/__tests__/TuningAndCalibration.test.ts',
    '**/src/world/engine/__tests__/PhysicsIntegration.test.ts',
    '**/src/world/engine/__tests__/multiAgentComposition.test.ts',
    '**/src/world/engine/__tests__/walkSign.test.ts'
  ],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { useESM: true, tsconfig: { module: 'esnext', esModuleInterop: true, skipLibCheck: true, checkJs: false, target: 'ES2022', lib: ['ES2022'], types: ['node', 'jest'] } }],
  },
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
