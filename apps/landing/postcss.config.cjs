/** @type {import('postcss-load-config').Config} */
module.exports = {
  plugins: {
    // Enable Tailwind CSS processing for @tailwind/@apply directives.
    tailwindcss: {
      config: "./tailwind.config.js",
    },
    autoprefixer: {},
  },
};

