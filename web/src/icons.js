// Agent ID 红包 icon set. Drawn for this site: 24px grid, 1.75 round strokes, one small solid dot
// per icon at most (the red packet's seal). Use with `I.name`; colour follows currentColor.
const svg = (body) =>
  `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
const dot = (cx, cy, r = 1.1) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor" stroke="none"/>`;

export const I = {
  packet: svg(`<rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M5 8.5c2.2 2 4.6 3 7 3s4.8-1 7-3"/>${dot(12, 11.5, 1.9)}`),
  wallet: svg(`<path d="M5 8V7a2.5 2.5 0 0 1 2.5-2.5H16"/><rect x="4" y="8" width="16" height="11.5" rx="2.5"/><path d="M20 12h-3.5a1.75 1.75 0 0 0 0 3.5H20"/>${dot(16.6, 13.75, 0.9)}`),
  arrowRight: svg(`<path d="M5 12h14M13 6l6 6-6 6"/>`),
  plus: svg(`<path d="M12 5v14M5 12h14"/>`),
  copy: svg(`<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.5"/><path d="M15.5 8.5V6.5A2.5 2.5 0 0 0 13 4H6.5A2.5 2.5 0 0 0 4 6.5V13a2.5 2.5 0 0 0 2.5 2.5h2"/>`),
  doc: svg(`<path d="M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8l-5-5Z"/><path d="M14 3v5h5M9 13h6M9 16.5h4"/>`),
  shield: svg(`<path d="M12 3l7 2.8v5.7c0 4.3-2.9 7.8-7 9.5-4.1-1.7-7-5.2-7-9.5V5.8L12 3Z"/><path d="M9 12l2.2 2.2L15.5 10"/>`),
  terminal: svg(`<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7 9.5l3 2.5-3 2.5M13 15h4"/>`),
  chat: svg(`<path d="M6 4.5h12A2.5 2.5 0 0 1 20.5 7v7.5A2.5 2.5 0 0 1 18 17h-6l-4.5 3.5V17H6a2.5 2.5 0 0 1-2.5-2.5V7A2.5 2.5 0 0 1 6 4.5Z"/><path d="M8 9.5h8M8 12.5h5"/>`),
  lock: svg(`<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>${dot(12, 15.5, 1.4)}`),
  globe: svg(`<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.4 2.6 3.7 5.6 3.7 9s-1.3 6.4-3.7 9c-2.4-2.6-3.7-5.6-3.7-9S9.6 5.6 12 3Z"/>`),
  at: svg(`<circle cx="12" cy="12" r="3.5"/><path d="M15.5 8.5v4.8a2.3 2.3 0 0 0 4.5.6c.3-.6.5-1.2.5-1.9a8.5 8.5 0 1 0-3.4 6.8"/>`),
  info: svg(`<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/>${dot(12, 7.8)}`),
  warning: svg(`<path d="M10.3 4.6a2 2 0 0 1 3.4 0l7.3 12.6a2 2 0 0 1-1.7 3H4.7a2 2 0 0 1-1.7-3l7.3-12.6Z"/><path d="M12 9.5v4.5"/>${dot(12, 17)}`),
  check: svg(`<path d="M5 12.5l4.5 4.5L19 7.5"/>`),
  checkCircle: svg(`<circle cx="12" cy="12" r="9"/><path d="M8 12.3l2.8 2.8 5.2-5.6"/>`),
  trophy: svg(`<path d="M8 4h8v5.5a4 4 0 0 1-8 0V4Z"/><path d="M8 6H5.5v1.2A3.3 3.3 0 0 0 8 10.5M16 6h2.5v1.2a3.3 3.3 0 0 1-2.5 3.3M12 13.5V17M8.5 20.5h7M9.5 17h5"/>`),
  external: svg(`<path d="M14 4h6v6M20 4l-8.5 8.5M18 14v3.5a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 4 17.5v-9A2.5 2.5 0 0 1 6.5 6H10"/>`),
  users: svg(`<circle cx="9" cy="8.5" r="3.5"/><path d="M3 19.5a6 6 0 0 1 12 0"/><path d="M15.5 5.2a3.5 3.5 0 0 1 0 6.6M17.5 14.2a6 6 0 0 1 3.5 5.3"/>`),
  share: svg(`<circle cx="17.5" cy="5.5" r="2.5"/><circle cx="6.5" cy="12" r="2.5"/><circle cx="17.5" cy="18.5" r="2.5"/><path d="M8.7 10.7l6.6-3.9M8.7 13.3l6.6 3.9"/>`),
  spark: svg(`<path d="M11 3.5l1.7 5.1 5.1 1.7-5.1 1.7L11 17.1l-1.7-5.1-5.1-1.7 5.1-1.7L11 3.5Z"/><path d="M18.5 15v5M16 17.5h5"/>`),
  refund: svg(`<path d="M4 9.5h11a5 5 0 0 1 0 10H9"/><path d="M8 5.5l-4 4 4 4"/>`),
  search: svg(`<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>`),
  idCard: svg(`<rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="8.5" cy="11" r="2"/><path d="M5.5 16a3 3 0 0 1 6 0M14.5 10h3.5M14.5 13.5h2.5"/>`),
  toggle: svg(`<rect x="2.5" y="7" width="19" height="10" rx="5"/>${dot(16.5, 12, 2.6)}`),
  sun: svg(`<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>`),
  moon: svg(`<path d="M20 14.6A8.2 8.2 0 0 1 9.4 4a8.2 8.2 0 1 0 10.6 10.6Z"/>`),
  lang: svg(`<path d="M3.5 5.5h9M8 3.5v2M5.5 5.5c.6 3.4 3 6.3 6 7.8M10.5 5.5c-.8 3.9-3.4 7.1-7 8.6"/><path d="M13.5 20.5l3.8-9.5 3.8 9.5M14.9 17h4.8"/>`),
  home: svg(`<path d="M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5H15v-6H9v6H5.5A1.5 1.5 0 0 1 4 19v-8.5Z"/>`),
  box: svg(`<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>`),
  xLogo: svg(`<path d="M5 4.5l14 15M19 4.5l-14 15"/>`),
  plane: svg(`<path d="M20.5 4 3.5 10.8l6.3 2.4 2.4 6.3L20.5 4Z"/><path d="M9.8 13.2 14 9"/>`),
  clock: svg(`<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>`),
};
