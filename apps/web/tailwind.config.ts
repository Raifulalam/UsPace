import type { Config } from 'tailwindcss';

const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: { bg: v('bg'), surface: v('surface'), ink: v('ink'), muted: v('muted'), accent: v('accent'), accent2: v('accent2'), line: v('line') },
      fontFamily: { sans: ['ui-rounded', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'] },
      boxShadow: { soft: '0 10px 40px -12px rgb(var(--accent2) / 0.35)' },
    },
  },
  plugins: [],
};
export default config;
