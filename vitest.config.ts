import { defineConfig } from 'vitest/config'

/** Keep standalone test discovery inside this package when nested in another repository. */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
  },
})
