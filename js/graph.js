/**
 * LLM Wiki — Knowledge Graph Renderer
 * D3.js force-directed graph of wiki page connections
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

/** pages 배열 → { nodes, links } 그래프 데이터 */
export function buildGraphData(pages) {
  const slugs = pages.map(p => p.slug);

  const nodes = pages.map(p => ({
    id: p.slug,
    label: p.title,
    contentLen: (p.content || '').length,
    tags: p.tags || [],
    updated: p.updated,
  }));

  const links = [];
  for (const p of pages) {
    const targets = parseWikiLinks(p.content || '', slugs);
    for (const t of targets) {
      if (t !== p.slug) {
        links.push({ source: p.slug, target: t });
      }
    }
  }

  return { nodes, links };
}

/** SVG에 D3 force graph 렌더링 */
export function renderGraph(svgEl, { nodes, links }, onNodeClick) {
  const d3 = window.d3;
  if (!d3) { console.error('D3.js not loaded'); return; }

  const W = svgEl.clientWidth || 360;
  const H = svgEl.clientHeight || 460;

  // 기존 내용 초기화
  d3.select(svgEl).selectAll('*').remove();

  const svg = d3.select(svgEl)
    .attr('width', W)
    .attr('height', H);

  // 배경 클릭 시 줌 리셋 이벤트
  const defs = svg.append('defs');

  // 그라디언트 정의 (엣지용)
  const grad = defs.append('linearGradient')
    .attr('id', 'link-grad')
    .attr('gradientUnits', 'userSpaceOnUse');
  grad.append('stop').attr('offset', '0%').attr('stop-color', '#8b5cf6').attr('stop-opacity', 0.6);
  grad.append('stop').attr('offset', '100%').attr('stop-color', '#06b6d4').attr('stop-opacity', 0.6);

  // 글로우 필터
  const glow = defs.append('filter').attr('id', 'glow');
  glow.append('feGaussianBlur').attr('stdDeviation', '3').attr('result', 'blur');
  const feMerge = glow.append('feMerge');
  feMerge.append('feMergeNode').attr('in', 'blur');
  feMerge.append('feMergeNode').attr('in', 'SourceGraphic');

  // 줌 컨테이너
  const g = svg.append('g').attr('class', 'graph-root');

  const zoom = d3.zoom()
    .scaleExtent([0.3, 3])
    .on('zoom', (event) => g.attr('transform', event.transform));
  svg.call(zoom);

  // Force simulation
  const simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(90).strength(0.5))
    .force('charge', d3.forceManyBody().strength(-220))
    .force('center', d3.forceCenter(W / 2, H / 2))
    .force('collision', d3.forceCollide().radius(d => nodeRadius(d) + 12));

  // 엣지 그리기
  const link = g.append('g').attr('class', 'links')
    .selectAll('line')
    .data(links)
    .join('line')
    .attr('stroke', 'url(#link-grad)')
    .attr('stroke-width', 1.5)
    .attr('stroke-opacity', 0.5);

  // 노드 그룹
  const node = g.append('g').attr('class', 'nodes')
    .selectAll('g')
    .data(nodes)
    .join('g')
    .attr('class', 'node-g')
    .style('cursor', 'pointer')
    .call(drag(simulation));

  // 노드 원
  node.append('circle')
    .attr('r', d => nodeRadius(d))
    .attr('fill', d => nodeColor(d))
    .attr('fill-opacity', 0.85)
    .attr('stroke', d => nodeStroke(d))
    .attr('stroke-width', 2)
    .attr('filter', 'url(#glow)');

  // 노드 라벨
  node.append('text')
    .text(d => d.label.length > 8 ? d.label.slice(0, 8) + '…' : d.label)
    .attr('text-anchor', 'middle')
    .attr('dy', d => nodeRadius(d) + 14)
    .attr('fill', '#c0c0e0')
    .attr('font-size', '10px')
    .attr('font-family', 'Inter, sans-serif')
    .attr('pointer-events', 'none');

  // 글자수 배지 (내용이 있는 페이지)
  node.filter(d => d.contentLen > 100)
    .append('text')
    .text(d => Math.round(d.contentLen / 100) * 100 > 9999
      ? '9.9k+' : (Math.round(d.contentLen / 100) * 100) + '자')
    .attr('text-anchor', 'middle')
    .attr('dy', '0.35em')
    .attr('fill', 'white')
    .attr('font-size', '7px')
    .attr('font-weight', '700')
    .attr('pointer-events', 'none');

  // 클릭 이벤트
  node.on('click', (event, d) => {
    event.stopPropagation();
    if (onNodeClick) onNodeClick(d.id);

    // 선택 효과
    node.selectAll('circle')
      .attr('stroke', nd => nd.id === d.id ? '#ffffff' : nodeStroke(nd))
      .attr('stroke-width', nd => nd.id === d.id ? 3 : 2);
  });

  // 터치 이벤트 (모바일)
  node.on('touchstart', (event, d) => {
    event.preventDefault();
    event.stopPropagation();
    if (onNodeClick) onNodeClick(d.id);
  }, { passive: false });

  // 시뮬레이션 tick
  simulation.on('tick', () => {
    link
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);

    node.attr('transform', d => {
      d.x = Math.max(20, Math.min(W - 20, d.x));
      d.y = Math.max(20, Math.min(H - 20, d.y));
      return `translate(${d.x},${d.y})`;
    });
  });

  // 연결 없는 경우 힌트 표시
  if (links.length === 0) {
    svg.append('text')
      .attr('x', W / 2).attr('y', H - 30)
      .attr('text-anchor', 'middle')
      .attr('fill', '#505070')
      .attr('font-size', '11px')
      .text('💡 메모 처리 후 [[페이지명]] 링크가 생기면 연결선이 표시됩니다');
  }

  return simulation;
}

// ─── 헬퍼 ────────────────────────────────────────────
function nodeRadius(d) {
  if (d.contentLen > 2000) return 22;
  if (d.contentLen > 500)  return 17;
  if (d.contentLen > 100)  return 13;
  return 9;
}

function nodeColor(d) {
  const tagColors = {
    daily: '#8b5cf6', work: '#8b5cf6', meeting: '#8b5cf6',
    project: '#06b6d4', milestone: '#06b6d4',
    idea: '#ec4899', insight: '#ec4899',
    learning: '#10b981', tech: '#10b981',
    people: '#f59e0b', communication: '#f59e0b',
    todo: '#f97316', deadline: '#f97316',
    issue: '#ef4444', bug: '#ef4444',
    reflection: '#a78bfa', review: '#a78bfa',
  };
  for (const tag of (d.tags || [])) {
    if (tagColors[tag]) return tagColors[tag];
  }
  return '#6060a0';
}

function nodeStroke(d) {
  return d.contentLen > 100 ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.15)';
}

function drag(simulation) {
  const d3 = window.d3;
  return d3.drag()
    .on('start', (event, d) => {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      d.fx = d.x; d.fy = d.y;
    })
    .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
    .on('end', (event, d) => {
      if (!event.active) simulation.alphaTarget(0);
      d.fx = null; d.fy = null;
    });
}
