// Tailwind CSS (v3.4.17, misma versión que servía cdn.tailwindcss.com).
// El CSS se genera UNA VEZ y se commitea (tailwind.css); no hay build en el despliegue.
// Si añades clases nuevas en index.html, regenera con:
//   npm run build:css
// y commitea tailwind.css. Las clases deben aparecer escritas completas en index.html
// (no construidas concatenando strings), o no se generarán.
module.exports = {
  content: ['./index.html'],
  theme: { extend: {} },
  plugins: [],
};
