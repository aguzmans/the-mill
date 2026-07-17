/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#080a10",
          900: "#0b0e14",
          850: "#0f131b",
          800: "#141924",
          700: "#1c2230",
          600: "#2a3244",
          500: "#3a4256",
        },
        brand: {
          400: "#818cf8",
          500: "#6366f1",
          600: "#4f46e5",
        },
        cyanx: "#22d3ee",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      keyframes: {
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
        pulseRing: {
          "0%": { boxShadow: "0 0 0 0 rgba(99,102,241,0.5)" },
          "70%": { boxShadow: "0 0 0 8px rgba(99,102,241,0)" },
          "100%": { boxShadow: "0 0 0 0 rgba(99,102,241,0)" },
        },
      },
      animation: {
        shimmer: "shimmer 1.6s infinite",
        pulseRing: "pulseRing 1.4s infinite",
      },
    },
  },
  plugins: [],
};
