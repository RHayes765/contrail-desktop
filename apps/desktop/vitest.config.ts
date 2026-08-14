import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      electron: path.resolve(__dirname, 'src/test/electron-stub.ts'),
    },
  },
  test: {
    include: ['src/test/**/*.test.ts'],
  },
});
