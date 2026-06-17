/**
 * LLM Wiki — Knowledge Graph Renderer
 * D3.js v7 force-directed graph
 */

/** wiki 마크다운에서 [[slug]] 링크 파싱 */
export function parseWikiLinks(content, allSlugs) {
  const found = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const slug = m[1].trim().toLowerCase().replace(/\s+/g, '-');
    if (allSlugs.includes(slug)) found.push(slug);
  }
  return [...new Set(found)];
}

/** pages 배열 → { nodes, links } */
export function buildGraphData(pages) {
  const slugs = pages.map(p => p.slug);
  const nodes = pages.map(p => ({
    id: p.slug,
    label: p.title,
    contentLen: (p.content || '').length,
    tags: p.tags || [],
  }));
  const links = [];
  for (const p of pages) {
    for (const t of parseWikiLinks(p.content || '', slugs)) {
      if (t !== p.slug) links.push({ source: p.slug, target: t });
    }
  }
  return { nodes, links };
}

/** SVG 엘리먼트에 D3 force graph 렌더링 */
export function renderGraph(svgEl, { nodes, links }, W, H, onNodeClick) {
  const d3 = window.d3;

  // D3 미로드 시 오류 표시
  if (!d3) {
    _svgText(svgEl, W / 2, H / 2, '⚠️ D3.js 로드 실패 (네트워크 확인)', '#ef4444', 13);
    console.error('[Graph] window.d3 is undefined — D3 CDN not loaded');
    return null;
  }

  if (nodes.length === 0) {
    _svgText(svgEl, W / 2, H / 2, '위키 페이지가 없습니다. Settings → 초기화를 눌러주세요.', '#505070', 12);
    return null;
  }

  // SVG 초기화
  d3.select(svgEl).selectAll('*').remove();

  const svg = d3.select(svgEl).attr('width', W).attr('height', H);

  // defs: 그라디언트, 글로우
  const defs = svg.append('defs');
  const grad = defs.append('linearGradient').attr('id', 'lg').attr('gradientUnits', 'userSpaceOnUse');
  grad.append('stop').attr('offset', '0%').attr('stop-color', '#8b5cf6').attr('stop-opacity', 0.7);
  grad.append('stop').attr('offset', '100%').attr('stop-color', '#06b6d4').attr('stop-opacity', 0.7);

  const filt = defs.append('filter').attr('id', 'glow');
  filt.append('feGaussianBlur').attr('stdDeviation', 3).attr('result', 'b');
  const fm = filt.append('feMerge');
  fm.append('feMergeNode').attr('in', 'b');
  fm.append('feMergeNode').attr('in', 'SourceGraphic');

  // 줌 그룹
  const g = svg.append('g');
  svg.call(d3.zoom().scaleExtent([0.25, 4])
    .on('zoom', e => g.attr('transform', e.transform)));

  // simulation
  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(100).strength(0.6))
    .force('charge', d3.forceManyBody().strength(-250))
    .force('center', d3.forceCenter(W / 2, H / 2))
    .force('collide', d3.forceCollide().radius(d => _r(d) + 14));

  // 엣지
  const linkSel = g.append('g').selectAll('line').data(links).join('line')
    .attr('stroke', 'url(#lg)')
    .attr('stroke-width', 1.8)
    .attr('stroke-opacity', 0.55);

  // 노드 그룹
  const nodeSel = g.append('g').selectAll('g').data(nodes).join('g')
    .style('cursor', 'pointer')
    .call(d3.drag()
      .on('start', (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag',  (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on('end',   (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));

  // 원
  nodeSel.append('circle')
    .attr('r', d => _r(d))
    .attr('fill', d => _color(d))
    .attr('fill-opacity', 0.88)
    .attr('stroke', 'rgba(255,255,255,0.35)')
    .attr('stroke-width', 2)
    .attr('filter', 'url(#glow)');

  // 라벨 (원 아래)
  nodeSel.append('text')
    .text(d => d.label.length > 7 ? d.label.slice(0, 7) + '…' : d.label)
    .attr('text-anchor', 'middle')
    .attr('dy', d => _r(d) + 13)
    .attr('fill', '#b0b0d0')
    .attr('font-size', 10)
    .attr('font-family', 'Inter, sans-serif')
    .attr('pointer-events', 'none');

  // 글자수 배지 (원 안)
  nodeSel.filter(d => d.contentLen > 100).append('text')
    .text(d => _sizeLabel(d.contentLen))
    .attr('text-anchor', 'middle').attr('dy', '0.35em')
    .attr('fill', 'white').attr('font-size', 7).attr('font-weight', 700)
    .attr('pointer-events', 'none');

  // 클릭 / 터치
  nodeSel.on('click', (e, d) => {
    e.stopPropagation();
    _highlight(nodeSel, d.id);
    if (onNodeClick) onNodeClick(d.id);
  });
  nodeSel.on('touchend', (e, d) => {
    e.preventDefault(); e.stopPropagation();
    _highlight(nodeSel, d.id);
    if (onNodeClick) onNodeClick(d.id);
  });

  // tick
  sim.on('tick', () => {
    linkSel
      .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    nodeSel.attr('transform', d => {
      d.x = Math.max(24, Math.min(W - 24, d.x));
      d.y = Math.max(24, Math.min(H - 24, d.y));
      return `translate(${d.x},${d.y})`;
    });
  });

  // 링크 없을 때 안내
  if (links.length === 0) {
    svg.append('text')
      .attr('x', W / 2).attr('y', H - 16)
      .attr('text-anchor', 'middle')
      .attr('fill', '#404060').attr('font-size', 11)
      .text('💡 메모 처리 후 [[페이지명]] 링크가 생기면 연결선이 나타납니다');
  }

  return sim;
}

// ── 헬퍼 ──────────────────────────────────────────────────
function _r(d) {
  if (d.contentLen > 2000) return 22;
  if (d.contentLen > 500)  return 17;
  if (d.contentLen > 100)  return 13;
  return 9;
}
function _color(d) {
  const map = {
    daily:'#8b5cf6', work:'#8b5cf6', meeting:'#8b5cf6',
    project:'#06b6d4', milestone:'#06b6d4',
    idea:'#ec4899', insight:'#ec4899',
    learning:'#10b981', tech:'#10b981',
    people:'#f59e0b', communication:'#f59e0b',
    todo:'#f97316', deadline:'#f97316',
    issue:'#ef4444', bug:'#ef4444',
    reflection:'#a78bfa', review:'#a78bfa',
  };
  for (const t of (d.tags || [])) if (map[t]) return map[t];
  return '#6060a0';
}
function _sizeLabel(n) {
  if (n >= 10000) return '10k+';
  return Math.round(n / 100) * 100 + '자';
}
function _highlight(nodeSel, id) {
  nodeSel.select('circle')
    .attr('stroke', d => d.id === id ? '#fff' : 'rgba(255,255,255,0.35)')
    .attr('stroke-width', d => d.id === id ? 3 : 2);
}
function _svgText(svgEl, x, y, msg, fill, size) {
  const ns = 'http://www.w3.org/2000/svg';
  const t = document.createElementNS(ns, 'text');
  t.setAttribute('x', x); t.setAttribute('y', y);
  t.setAttribute('text-anchor', 'middle');
  t.setAttribute('fill', fill);
  t.setAttribute('font-size', size);
  t.setAttribute('font-family', 'Inter, sans-serif');
  t.textContent = msg;
  svgEl.appendChild(t);
}
