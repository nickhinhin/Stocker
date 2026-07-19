import type { Config } from "tailwindcss";

export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    "./node_modules/shadcn-dropzone/dist/*.{js,mjs}",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
} satisfies Config;
