import * as migration_20260901_103830_initial from './20260901_103830_initial';

export const migrations = [
  {
    up: migration_20260901_103830_initial.up,
    down: migration_20260901_103830_initial.down,
    name: '20260901_103830_initial'
  },
];
