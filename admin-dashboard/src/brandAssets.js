const logoSvg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 230" role="img" aria-label="Sayed Elsenosy Tech">
<defs>
 <linearGradient id="teal" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#11f0d1"/><stop offset=".48" stop-color="#079c8f"/><stop offset="1" stop-color="#043d42"/></linearGradient>
 <linearGradient id="gold" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#ffe276"/><stop offset=".5" stop-color="#f2b43c"/><stop offset="1" stop-color="#9f6712"/></linearGradient>
 <linearGradient id="steel" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#203036"/><stop offset=".55" stop-color="#101a1f"/><stop offset="1" stop-color="#030708"/></linearGradient>
 <filter id="glow"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs>
<g transform="skewX(-8)">
 <text x="24" y="145" font-family="Arial Black,Arial,sans-serif" font-size="154" font-weight="900" letter-spacing="-18" fill="url(#teal)">S</text>
 <text x="132" y="145" font-family="Arial Black,Arial,sans-serif" font-size="154" font-weight="900" letter-spacing="-18" fill="url(#steel)">E</text>
 <text x="252" y="145" font-family="Arial Black,Arial,sans-serif" font-size="154" font-weight="900" letter-spacing="-12" fill="url(#gold)">T</text>
 <path d="M36 160 C128 132 185 164 293 118" fill="none" stroke="url(#gold)" stroke-width="9" stroke-linecap="round"/>
 <path d="M89 45 C164 32 240 55 329 26" fill="none" stroke="#10ddc5" stroke-opacity=".55" stroke-width="5" stroke-linecap="round"/>
</g>
<text x="36" y="206" font-family="Arial,Helvetica,sans-serif" font-size="27" font-weight="800" fill="#f3f7f6">Sayed Elsenosy</text>
<text x="268" y="206" font-family="Arial,Helvetica,sans-serif" font-size="27" font-weight="900" fill="#11d8c0" filter="url(#glow)">Tech</text>
</svg>`;
export const BRAND_IMAGE='data:image/svg+xml;charset=UTF-8,'+encodeURIComponent(logoSvg);
