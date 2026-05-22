import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#f0f4ff',
          500: '#4f5df7',
          600: '#3d4de6',
          700: '#2d3ad4',
        },
      },
    },
  },
  plugins: [],
} satisfies Config
