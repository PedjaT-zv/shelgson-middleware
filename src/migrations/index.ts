import * as migration_20260901_115614_initial from './20260901_115614_initial';

export const migrations = [
  {
    up: migration_20260901_115614_initial.up,
    down: migration_20260901_115614_initial.down,
    name: '20260901_115614_initial'
  },
];
