/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        petbot: {
          surface: "#F7F7F7",
          surfaceHighlight: "#F0F0F2",
          card: "#FFFFFF",
          border: "#E4E4E7",
          borderLight: "#D4D4D8",
          accent: "#111111",
          accentWarm: "#52525B",
          cyan: "#111111",
          lime: "#16A34A",
          textPrimary: "#111111",
          textMuted: "#52525B",
          textSubtle: "#71717A",
        },
      },
      fontFamily: {
        mono: ["JetBrains Mono", "SF Mono", "Menlo", "Courier New", "monospace"],
        sans: ["Inter", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
      },
      boxShadow: {
        glow: "0 1px 3px rgba(0, 0, 0, 0.08)",
        glowCyan: "0 1px 3px rgba(0, 0, 0, 0.08)",
        card: "0 1px 2px rgba(0, 0, 0, 0.04)",
      },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "blink": "blink 4s infinite",
      },
      keyframes: {
        blink: {
          "0%, 45%, 55%, 100%": { transform: "scaleY(1)" },
          "50%": { transform: "scaleY(0.1)" },
        },
      },
    },
  },
  plugins: [],
};
