/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        mono:    ['"JetBrains Mono"', '"IBM Plex Mono"', 'ui-monospace', 'Menlo', 'monospace'],
        sans:    ['"Inter"', 'system-ui', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'sans-serif'],
        display: ['"Cormorant Garamond"', '"Georgia"', 'serif'],
        script:  ['"Caveat"', '"Permanent Marker"', 'cursive'],
      },
      colors: {
        // Ziflow blue-cinematic dark surfaces.
        surface: {
          0: '#0a0f17',   // deepest bg (page background)
          1: '#0d1320',   // app bg
          2: '#111827',   // card bg
          3: '#161f31',   // hover / input bg
          4: '#1f2a3d',   // border
          5: '#2a3754',   // border-hard
        },
        // Cyan accent. Keeps `bg-accent`, `text-accent` working everywhere.
        accent: {
          DEFAULT: '#6bd6e0',
          muted:   '#2e6973',
          dim:     '#15333a',
        },
        // Override neutral zinc so generic `text-zinc-400` etc. inherit the
        // blue-tinted fg ladder. Tailwind's named zinc shades are remapped
        // to ziflow's fg palette where it makes visual sense.
        zinc: {
          50:  '#f5f8fc',
          100: '#eaf0f8',
          200: '#d8e2ee',  // fg
          300: '#c1cde0',
          400: '#8a98ad',  // fg-mute
          500: '#5e6c82',  // fg-dim
          600: '#3e4a5e',  // fg-faint
          700: '#2a3754',
          800: '#1f2a3d',
          900: '#161f31',
          950: '#0a0f17',
        },
        // Status — keeps existing usages of bg-amber-*, bg-red-*, bg-green-*
        // through Tailwind defaults, but exposes named tokens for new code.
        ok:    '#7fd49a',
        warn:  '#f5c266',
        err:   '#ff7373',
        info:  '#7aa6ff',
        violet: { DEFAULT: '#a99bff' },
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
