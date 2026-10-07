const logoSvg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 300" role="img" aria-label="Sayed Elsenosy Tech">
<defs>
 <linearGradient id="sgrad" x1="0" x2="1"><stop stop-color="#ff7a16"/><stop offset=".48" stop-color="#ff9a2c"/><stop offset=".55" stop-color="#39dfff"/><stop offset="1" stop-color="#13bfe7"/></linearGradient>
 <linearGradient id="orange" x1="0" x2="1"><stop stop-color="#ff6b08"/><stop offset="1" stop-color="#ffab38"/></linearGradient>
 <linearGradient id="cyan" x1="0" x2="1"><stop stop-color="#0bc7ee"/><stop offset="1" stop-color="#70efff"/></linearGradient>
 <filter id="glow"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs>
<g transform="translate(24 18)" filter="url(#glow)">
 <path d="M220 72C172 34 119 34 67 55c38 5 67 17 95 34-48-13-90-7-132 17 53 1 92 13 128 36-43-6-78 1-114 24 56-1 97 13 137 39" fill="none" stroke="url(#orange)" stroke-width="16" stroke-linecap="round"/>
 <path d="M292 72c48-38 101-38 153-17-38 5-67 17-95 34 48-13 90-7 132 17-53 1-92 13-128 36 43-6 78 1 114 24-56-1-97 13-137 39" fill="none" stroke="url(#cyan)" stroke-width="16" stroke-linecap="round"/>
 <text x="203" y="176" font-family="Arial Black,Arial,sans-serif" font-size="160" font-style="italic" font-weight="900" fill="url(#sgrad)">S</text>
</g>
<text x="84" y="248" font-family="Arial,Helvetica,sans-serif" font-size="36" font-weight="900" fill="#ff8b24">Sayed</text>
<text x="206" y="248" font-family="Arial,Helvetica,sans-serif" font-size="36" font-weight="800" fill="#eaf8ff">Elsenosy</text>
<text x="380" y="248" font-family="Arial,Helvetica,sans-serif" font-size="36" font-weight="900" fill="#27d8f2">Tech</text>
<text x="142" y="282" font-family="Arial,Helvetica,sans-serif" font-size="18" font-weight="700" fill="#84a7b7">DELIVERY RECRUITMENT PLATFORM</text>
</svg>`;
export const BRAND_IMAGE='data:image/svg+xml;charset=UTF-8,'+encodeURIComponent(logoSvg);
