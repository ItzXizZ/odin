/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['Instrument Serif', 'Georgia', 'Times New Roman', 'serif'],
        caveat: ['Instrument Serif', 'Georgia', 'Times New Roman', 'serif'],
        writing: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        serif: ['Instrument Serif', 'Georgia', 'Times New Roman', 'serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
      },
      colors: {
        canvas: {
          base: 'rgb(215, 215, 215)',
          card: 'rgba(255, 255, 255, 0.18)',
          hover: 'rgba(255, 255, 255, 0.28)',
          border: 'rgba(0, 0, 0, 0.1)',
          borderHover: 'rgba(0, 0, 0, 0.2)',
        },
        accent: {
          gold: 'rgba(30, 65, 140, 1)',
          goldLight: 'rgba(50, 90, 180, 1)',
          green: 'rgba(30, 110, 60, 1)',
          red: 'rgba(150, 35, 35, 1)',
          blue: 'rgba(80, 130, 230, 1)',
        },
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
}
