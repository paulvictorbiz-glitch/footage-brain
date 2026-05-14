/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        mono: ['"JetBrains Mono"', '"Fira Code"', 'ui-monospace', 'monospace'],
        sans: ['"DM Sans"', 'system-ui', 'sans-serif'],
        display: ['"Space Grotesk"', '"DM Sans"', 'sans-serif'],
      },
      colors: {
        // Dark background palette
        surface: {
          0: '#0a0a0b',   // deepest bg
          1: '#111113',   // main bg
          2: '#18181b',   // card bg
          3: '#1e1e22',   // hover bg
          4: '#27272b',   // border
          5: '#3f3f46',   // muted border
        },
        // Accent - amber/gold for a pro filmmaking feel
        accent: {
          DEFAULT: '#f59e0b',
          muted: '#92400e',
          dim: '#451a03',
        },
        // Semantic
        ok: '#22c55e',
        warn: '#f59e0b',
        err: '#ef4444',
        info: '#3b82f6',
      },
      animation: {
        'fade-in': 'fadeIn 0.15s ease-out',
        'slide-up': 'slideUp 0.2s ease-out',
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
      keyframes: {
        fadeIn: {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        slideUp: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
}
