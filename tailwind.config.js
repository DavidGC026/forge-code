/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Forge Code — graphite surfaces, carmine selection and muted gold
        'forge-bg': '#202228',          // Main graphite background
        'forge-titlebar': '#191B20',    // Title bar (slightly darker)
        'forge-activitybar': '#191B20', // Activity bar
        'forge-sidebar': '#1E2026',     // Sidebar
        'forge-tabbar': '#1B1D23',      // Tab bar (inactive tabs)
        'forge-tab-active': '#252830',  // Active tab + editor bg
        'forge-editor': '#252830',      // Editor bg
        'forge-statusbar': '#1B1D23',   // Status bar
        'forge-terminal': '#191B20',    // Terminal bg
        'forge-border': '#343740',      // Borders
        'forge-input': '#191B20',       // Input bg

        // Text colors
        'forge-text':       '#D9DCE3',  // Inactive text/icons
        'forge-text-strong':'#FFFFFF',  // Hover/selected
        'forge-text-dim':   '#A2A7B3',  // Status bar text
        'forge-text-tab':   '#A2A7B3',  // Inactive tab text
        'forge-text-term':  '#B1B4BC',  // Terminal text
        'forge-text-menu':  '#D3D5DE',  // Dropdown unselected
        'forge-gold':       '#C5A572',
        'forge-accent':     '#E05A68',  // Carmine accent / highlight
      },
    },
  },
  plugins: [],
};
