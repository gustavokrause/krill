import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class", '[data-theme="dark"]'],
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-ubuntu)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-ubuntu-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      colors: {
        bg: "rgb(var(--bg) / <alpha-value>)",
        surface: {
          DEFAULT: "rgb(var(--surface) / <alpha-value>)",
          2: "rgb(var(--surface-2) / <alpha-value>)",
        },
        text: {
          DEFAULT: "rgb(var(--text) / <alpha-value>)",
          2: "rgb(var(--text-2) / <alpha-value>)",
          3: "rgb(var(--text-3) / <alpha-value>)",
        },
        border: {
          DEFAULT: "rgb(var(--border) / <alpha-value>)",
          strong: "rgb(var(--border-strong) / <alpha-value>)",
        },
        primary: "rgb(var(--primary) / <alpha-value>)",
        success: "rgb(var(--success) / <alpha-value>)",
        danger: "rgb(var(--danger) / <alpha-value>)",
        info: "rgb(var(--info) / <alpha-value>)",
        warning: "rgb(var(--warning) / <alpha-value>)",
        muted: "rgb(var(--muted) / <alpha-value>)",
        human: "rgb(var(--human) / <alpha-value>)",
        ai: "rgb(var(--ai) / <alpha-value>)",
      },
      borderRadius: {
        sm: "2px",
        DEFAULT: "4px",
      },
    },
  },
  plugins: [],
};

export default config;
