const logoSvg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 300" role="img" aria-label="Sayed Elsenosy Tech">
<defs>
  <linearGradient id="blue" x1="0" y1="0" x2="1" y2="1">
    <stop stop-color="#21ecff"/><stop offset=".35" stop-color="#0b9cff"/><stop offset=".7" stop-color="#1757ff"/><stop offset="1" stop-color="#70f7ff"/>
  </linearGradient>
  <linearGradient id="blue2" x1="0" y1="0" x2="1" y2="0">
    <stop stop-color="#0fe7ff"/><stop offset=".5" stop-color="#0e7cff"/><stop offset="1" stop-color="#24dcff"/>
  </linearGradient>
  <filter id="glow"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs>
<g transform="translate(28 26) skewX(-10)" filter="url(#glow)">
  <path d="M40 72h178l-28 34H72l-17 21h124l-27 33H18l-18-33z" fill="url(#blue)"/>
  <path d="M210 72h156l-26 33h-91l-20 24h94l-25 32H166z" fill="url(#blue)"/>
  <path d="M354 72h148l-26 34h-52l-48 55h-50l48-55h-47z" fill="url(#blue)"/>
  <rect x="485" y="31" width="19" height="19" rx="3" fill="#11dfff"/>
  <rect x="511" y="18" width="15" height="15" rx="3" fill="#0d9cff"/>
  <rect x="510" y="43" width="22" height="22" rx="3" fill="#20efff"/>
  <rect x="535" y="34" width="13" height="13" rx="2" fill="#0d7cff"/>
</g>
<text x="280" y="220" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="36" font-weight="800" fill="url(#blue2)">Sayed Elsenosy Tech</text>
<g fill="#1edcff" transform="translate(235 244) skewX(-20)">
 <rect width="28" height="8" rx="3"/><rect x="34" width="28" height="8" rx="3"/><rect x="68" width="28" height="8" rx="3"/>
</g>
</svg>`;
export const BRAND_IMAGE='data:image/svg+xml;charset=UTF-8,'+encodeURIComponent(logoSvg);
