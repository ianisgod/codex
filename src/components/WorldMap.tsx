import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { World } from '../simulation';
import './WorldMap.css';

type Cell = World['geography']['cells'][number];
type Civilization = World['civilizations'][number];
type Point = { x: number; y: number };
type MapProps = {
  world: World;
  layer: string;
  onSelectCivilization: (id: string) => void;
  onSelectSettlement?: (id: string) => void;
  compact?: boolean;
};

const WIDTH = 1000;
const HEIGHT = 600;
const palette = ['#afbc96', '#aa93bd', '#c0a574', '#a5b4bf', '#bc8773', '#93bcb0', '#b1ad7c', '#b38fa3'];
const number = (value: number) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}m` : value >= 1_000 ? `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k` : Math.round(value).toLocaleString();
const hash = (x: number, y: number) => {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
};

/** Trace contiguous tiles into closed, softened outlines rather than drawing a grid. */
function outline(cells: Cell[], width: number, height: number): string {
  if (!cells.length) return '';
  const occupied = new Set(cells.map(c => `${c.x},${c.y}`));
  const edges = new Map<string, Point[]>();
  const add = (a: Point, b: Point) => {
    const key = `${a.x},${a.y}`;
    edges.set(key, [...(edges.get(key) || []), b]);
  };
  for (const c of cells) {
    const { x, y } = c;
    if (!occupied.has(`${x},${y - 1}`)) add({ x, y }, { x: x + 1, y });
    if (!occupied.has(`${x + 1},${y}`)) add({ x: x + 1, y }, { x: x + 1, y: y + 1 });
    if (!occupied.has(`${x},${y + 1}`)) add({ x: x + 1, y: y + 1 }, { x, y: y + 1 });
    if (!occupied.has(`${x - 1},${y}`)) add({ x, y: y + 1 }, { x, y });
  }
  const paths: string[] = [];
  let remaining = [...edges.values()].reduce((n, e) => n + e.length, 0);
  while (remaining > 0) {
    const first = [...edges.entries()].find(([, targets]) => targets.length);
    if (!first) break;
    const [sx, sy] = first[0].split(',').map(Number);
    const start = { x: sx, y: sy };
    const points: Point[] = [start];
    let cursor = start;
    let budget = remaining + 2;
    while (budget-- > 0) {
      const available = edges.get(`${cursor.x},${cursor.y}`);
      if (!available?.length) break;
      cursor = available.pop()!;
      remaining--;
      if (cursor.x === start.x && cursor.y === start.y) break;
      points.push(cursor);
    }
    if (points.length < 3) continue;
    const simple = points.filter((p, i) => {
      const previous = points[(i - 1 + points.length) % points.length];
      const next = points[(i + 1) % points.length];
      return (p.x - previous.x) * (next.y - p.y) !== (p.y - previous.y) * (next.x - p.x);
    });
    const scaled = simple.map(p => ({ x: p.x * WIDTH / width, y: p.y * HEIGHT / height }));
    if (scaled.length < 3) continue;
    const last = scaled[scaled.length - 1];
    const initial = scaled[0];
    let path = `M${((last.x + initial.x) / 2).toFixed(1)},${((last.y + initial.y) / 2).toFixed(1)}`;
    scaled.forEach((p, i) => {
      const next = scaled[(i + 1) % scaled.length];
      path += `Q${p.x.toFixed(1)},${p.y.toFixed(1)} ${((p.x + next.x) / 2).toFixed(1)},${((p.y + next.y) / 2).toFixed(1)}`;
    });
    paths.push(`${path}Z`);
  }
  return paths.join(' ');
}

function layerColor(civ: Civilization, index: number, layer: string, world: World): string {
  const relative = (field: 'population' | 'treasury' | 'military') => civ[field] / Math.max(1, ...world.civilizations.map(c => c[field]));
  switch (layer) {
    case 'religion': return palette[Math.max(0, world.religions.findIndex(r => r.id === civ.religionId)) % palette.length];
    case 'population': return relative('population') > .88 ? '#bbcb95' : relative('population') > .72 ? '#87a889' : '#657e73';
    case 'economy': return relative('treasury') > .8 ? '#cfb976' : relative('treasury') > .5 ? '#b99d71' : '#8b9175';
    case 'military': return relative('military') > .88 ? '#bb7970' : relative('military') > .72 ? '#b49678' : '#819b8b';
    case 'climate': return civ.climate > 1.08 ? '#c6a574' : civ.climate < .9 ? '#8cabb6' : '#87ac8b';
    case 'disease': return civ.disease?.infected ? '#b66e62' : '#7f9a85';
    case 'culture': return palette[(index + 2) % palette.length];
    default: return civ.color || palette[index % palette.length];
  }
}

function metric(civ: Civilization, layer: string, world: World): string {
  switch (layer) {
    case 'population': return `${number(civ.population)} inhabitants`;
    case 'economy': return `${number(civ.treasury)} gold in treasury`;
    case 'military': return `${number(civ.military)} soldiers`;
    case 'religion': return world.religions.find(r => r.id === civ.religionId)?.name || 'Ancestral beliefs';
    case 'culture': return civ.culture.language;
    case 'climate': return civ.climate > 1.08 ? 'Warm climate' : civ.climate < .9 ? 'Cool climate' : 'Temperate climate';
    case 'disease': return civ.disease ? `${civ.disease.name} · ${number(civ.disease.infected)} infected` : 'No active outbreak';
    default: return civ.government;
  }
}

export function WorldMap({ world, layer, onSelectCivilization, onSelectSettlement, compact = false }: MapProps) {
  const uid = useId().replace(/:/g, '');
  const normalizedLayer = layer.toLowerCase();
  const geography = world.geography;
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; pan: Point } | null>(null);
  const moved = useRef(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }); setHovered(null); }, [world.id]);
  const map = useMemo(() => {
    const land = geography.cells.filter(c => c.biome !== 'ocean');
    const terrain = land.filter(c => hash(c.x, c.y) > (c.biome === 'mountains' ? .31 : .64));
    const regions = world.civilizations.map(civ => ({ id: civ.id, path: outline(land.filter(c => c.civId === civ.id), geography.width, geography.height) }));
    const shelf = (radius: number) => {
      const expanded = new Set<string>();
      land.forEach(cell => {
        for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) {
          if (dx * dx + dy * dy <= radius * radius) expanded.add(`${cell.x + dx},${cell.y + dy}`);
        }
      });
      return outline(geography.cells.filter(c => expanded.has(`${c.x},${c.y}`)), geography.width, geography.height);
    };
    const contour = shelf(3);
    const shallow = shelf(1);
    const highlands = outline(land.filter(c => c.elevation > .72), geography.width, geography.height);
    const coordinate = (c: Point) => ({ x: (c.x + .5) * WIDTH / geography.width, y: (c.y + .5) * HEIGHT / geography.height });
    const riverRows = new Map<number, Cell[]>();
    geography.cells.filter(c => c.biome === 'river').forEach(c => riverRows.set(c.y, [...(riverRows.get(c.y) || []), c]));
    const riverPoints = [...riverRows.entries()].sort(([a], [b]) => a - b).map(([y, cells]) => coordinate({ x: cells.reduce((sum, c) => sum + c.x, 0) / cells.length, y }));
    const river = riverPoints.map((point, i) => {
      if (i === 0) return `M${point.x},${point.y}`;
      const next = riverPoints[i + 1];
      return next ? `Q${point.x},${point.y} ${(point.x + next.x) / 2},${(point.y + next.y) / 2}` : `T${point.x},${point.y}`;
    }).join(' ');
    const centers = world.civilizations.map(civ => {
      const cells = land.filter(c => c.civId === civ.id);
      const fallback = geography.settlements.find(s => s.civId === civ.id);
      const center = cells.length ? { x: cells.reduce((n, c) => n + c.x, 0) / cells.length, y: cells.reduce((n, c) => n + c.y, 0) / cells.length } : fallback || { x: 0, y: 0 };
      return { id: civ.id, ...coordinate(center), visible: cells.length > 0 };
    });
    return { land: outline(land, geography.width, geography.height), contour, shallow, highlands, regions, centers, terrain, coordinate, river };
  }, [geography, world.civilizations.length]);
  const settlement = geography.settlements.find(s => s.id === hovered);
  const settlementCiv = settlement && world.civilizations.find(c => c.id === settlement.civId);
  const activeWars = world.wars.filter(w => w.active);
  const clampPan = (value: Point, nextZoom = zoom) => ({ x: Math.max(-WIDTH * (nextZoom - 1) / 2, Math.min(WIDTH * (nextZoom - 1) / 2, value.x)), y: Math.max(-HEIGHT * (nextZoom - 1) / 2, Math.min(HEIGHT * (nextZoom - 1) / 2, value.y)) });
  const changeZoom = (amount: number) => {
    const next = Math.max(1, Math.min(3.5, zoom + amount));
    setZoom(next);
    setPan(value => clampPan(value, next));
  };
  const select = (id: string) => { if (!moved.current) onSelectCivilization(id); };
  const routes = useMemo(() => geography.settlements.filter((_, i) => i % 2 === 0).slice(0, 7).map((from, i, list) => {
    const target = list[(i + 1) % list.length];
    if (!target || target.id === from.id) return null;
    const a = map.coordinate(from), b = map.coordinate(target);
    const curve = Math.min(95, Math.hypot(b.x - a.x, b.y - a.y) * .21);
    return { id: from.id, path: `M${a.x},${a.y}Q${(a.x + b.x) / 2},${(a.y + b.y) / 2 - curve} ${b.x},${b.y}` };
  }).filter(Boolean), [geography, map]);

  return <div className={`gmap ${compact ? 'gmap--compact' : ''} ${dragging ? 'gmap--dragging' : ''}`}>
    <svg ref={svgRef} className="gmap-canvas" viewBox={`-20 -10 ${WIDTH + 40} ${HEIGHT + 20}`} preserveAspectRatio="xMidYMid meet" role="group" aria-label={`${world.name} world map, ${normalizedLayer} layer. Drag to pan and use the zoom controls to explore.`}
      onPointerDown={e => { if (e.button !== 0) return; moved.current = false; drag.current = { x: e.clientX, y: e.clientY, pan }; setDragging(true); }}
      onPointerMove={e => {
        if (!drag.current || !svgRef.current) return;
        const box = svgRef.current.getBoundingClientRect();
        const scale = Math.min(box.width / (WIDTH + 40), box.height / (HEIGHT + 20));
        const dx = (e.clientX - drag.current.x) / scale;
        const dy = (e.clientY - drag.current.y) / scale;
        if (Math.abs(dx) + Math.abs(dy) > 4) { moved.current = true; svgRef.current.setPointerCapture(e.pointerId); }
        setPan(clampPan({ x: drag.current.pan.x + dx, y: drag.current.pan.y + dy }));
      }}
      onPointerUp={e => { drag.current = null; setDragging(false); if (svgRef.current?.hasPointerCapture(e.pointerId)) svgRef.current.releasePointerCapture(e.pointerId); }}
      onPointerCancel={() => { drag.current = null; setDragging(false); }}
      onPointerLeave={e => { if (!svgRef.current?.hasPointerCapture(e.pointerId)) { drag.current = null; setDragging(false); } }}>
      <defs>
        <radialGradient id={`${uid}-ocean`} cx="48%" cy="48%" r="75%"><stop offset="0" stopColor="#192f35"/><stop offset=".7" stopColor="#15272d"/><stop offset="1" stopColor="#101f24"/></radialGradient>
        <linearGradient id={`${uid}-land`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#65765d"/><stop offset="1" stopColor="#596957"/></linearGradient>
        <pattern id={`${uid}-grid`} width="100" height="100" patternUnits="userSpaceOnUse"><path d="M100 0H0V100" fill="none" stroke="#aac0b3" strokeOpacity=".065" strokeWidth=".6"/></pattern>
        <pattern id={`${uid}-grain`} width="37" height="37" patternUnits="userSpaceOnUse"><path d="M4 7l2 1m21 7l2-1M13 29l1 2m20 3l2-1" stroke="#dae0ba" strokeWidth=".55" strokeOpacity=".17"/><circle cx="23" cy="32" r=".5" fill="#0c201e" opacity=".3"/></pattern>
        <clipPath id={`${uid}-land-clip`}><path d={map.land}/></clipPath>
        <filter id={`${uid}-coast-shadow`} x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#061419" floodOpacity=".45"/></filter>
        <symbol id={`${uid}-mountain`} viewBox="-7 -8 14 15"><path d="M-6 5 0-6 6 5M-2-2 0 0 2-2" fill="none" stroke="#253d30" strokeWidth=".9" strokeLinejoin="round"/><path d="m0-6 6 11H1Z" fill="#223a2c" opacity=".18"/></symbol>
        <symbol id={`${uid}-tree`} viewBox="-4 -7 8 13"><path d="m0-6-3 6h2l-3 3h8L1 0h2ZM0 3v3" fill="#294331" fillOpacity=".43" stroke="#294331" strokeWidth=".6"/></symbol>
      </defs>
      <rect x="-1000" y="-600" width="3000" height="1800" fill={`url(#${uid}-ocean)`}/>
      <g transform={`translate(${WIDTH / 2 + pan.x} ${HEIGHT / 2 + pan.y}) scale(${zoom}) translate(${-WIDTH / 2} ${-HEIGHT / 2})`}>
        <rect x="-1000" y="-600" width="3000" height="1800" fill={`url(#${uid}-grid)`}/>
        <path d={map.contour} fill="#254047" opacity=".19" stroke="#688780" strokeWidth=".7" strokeOpacity=".12"/>
        <path d={map.shallow} fill="#28494b" opacity=".20" stroke="#81a098" strokeWidth=".7" strokeOpacity=".12"/>
        <g className="gmap-ocean-labels"><text x="150" y="142" transform="rotate(-13 150 142)">THE SILENT SEA</text><text x="692" y="484" transform="rotate(-12 692 484)">VERDANT OCEAN</text><text className="gmap-ocean-small" x="55" y="475" transform="rotate(-68 55 475)">WESTERN REACH</text></g>
        <path d={map.land} fill={`url(#${uid}-land)`} filter={`url(#${uid}-coast-shadow)`}/>
        <g clipPath={`url(#${uid}-land-clip)`}>
          {map.regions.map((region, index) => {
            const civ = world.civilizations.find(c => c.id === region.id);
            if (!civ) return null;
            return <path key={region.id} d={region.path} fill={layerColor(civ, index, normalizedLayer, world)} fillOpacity={normalizedLayer === 'political' ? .32 : .52} stroke={layerColor(civ, index, normalizedLayer, world)} strokeOpacity=".43" strokeWidth="1.2" className="gmap-region" onClick={() => select(civ.id)}><title>{`${civ.name} — ${metric(civ, normalizedLayer, world)}`}</title></path>;
          })}
          <path d={map.highlands} fill="#d4c5a0" opacity=".11" stroke="#d1c7a3" strokeWidth=".6" strokeOpacity=".12"/>
          <rect width={WIDTH} height={HEIGHT} fill={`url(#${uid}-grain)`} pointerEvents="none"/>
          <path d={map.river} fill="none" stroke="#304d43" strokeWidth="3.7" strokeOpacity=".45" pointerEvents="none"/>
          <path d={map.river} fill="none" stroke="#93aca4" strokeWidth="1.6" strokeOpacity=".66" pointerEvents="none"/>
          {map.terrain.map(c => {
            const p = map.coordinate(c);
            if (c.biome === 'mountains') return <use key={`${c.x}-${c.y}`} href={`#${uid}-mountain`} x={p.x - 7} y={p.y - 8} width="14" height="15" opacity=".82" pointerEvents="none"/>;
            if (c.biome === 'forest') return <use key={`${c.x}-${c.y}`} href={`#${uid}-tree`} x={p.x - 4} y={p.y - 6} width="8" height="12" opacity=".8" pointerEvents="none"/>;
            if (c.biome === 'desert') return <path key={`${c.x}-${c.y}`} d={`M${p.x - 5} ${p.y + 2}q5-5 10 0m-8 3q4-3 8 0`} fill="none" stroke="#c1b481" strokeWidth=".7" opacity=".42" pointerEvents="none"/>;
            return null;
          })}
        </g>
        <path d={map.land} fill="none" stroke="#b4bea0" strokeOpacity=".42" strokeWidth="1.2" pointerEvents="none"/>
        {(normalizedLayer === 'political' || normalizedLayer === 'economy' || normalizedLayer === 'culture') && <g className="gmap-trade-routes">{routes.map(route => route && <path key={route.id} d={route.path}/>)}<title>Maritime and overland trade corridors</title></g>}
        {normalizedLayer === 'military' && activeWars.map(war => {
          const a = map.centers.find(c => c.id === war.attackerId), b = map.centers.find(c => c.id === war.defenderId);
          if (!a || !b) return null;
          return <g key={war.id} className="gmap-war-route"><path d={`M${a.x} ${a.y}Q${(a.x + b.x) / 2} ${(a.y + b.y) / 2 - 40} ${b.x} ${b.y}`}/><text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 20}>⚔</text><title>{war.name}</title></g>;
        })}
        <g className="gmap-civ-labels">{map.centers.map((center, index) => {
          const civ = world.civilizations.find(c => c.id === center.id);
          if (!civ || !center.visible) return null;
          const shortName = civ.name.replace(/^(Kingdom of |Republic of |Empire of |The )/i, '');
          return <g key={civ.id} className="gmap-civ-label" role="button" tabIndex={0} aria-label={`Inspect ${civ.name}`} onClick={() => select(civ.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectCivilization(civ.id); } }} transform={`translate(${center.x} ${center.y - 46})`}>
            <text className="gmap-region-name" textAnchor="middle" style={{ fill: '#e1dfbe' }}>{shortName.toUpperCase()}</text>
            <text className="gmap-region-description" y="15" textAnchor="middle" style={{ fill: layerColor(civ, index, normalizedLayer, world) }}>{normalizedLayer === 'political' ? civ.government.toLowerCase() : metric(civ, normalizedLayer, world)}</text>
          </g>;
        })}</g>
        <g className="gmap-settlements">{geography.settlements.map((city, index) => {
          const p = map.coordinate(city);
          const civ = world.civilizations.find(c => c.id === city.civId);
          const capital = civ?.capital === city.name || geography.settlements.find(s => s.civId === city.civId)?.id === city.id;
          const labelBelow = index % 3 === 1;
          const densityRadius = normalizedLayer === 'population' ? Math.min(15, 3 + Math.sqrt(city.population) / 105) : 0;
          return <g key={city.id} transform={`translate(${p.x} ${p.y})`} className={`gmap-city ${capital ? 'gmap-city--capital' : ''}`} tabIndex={0} role="button" aria-label={`${city.name}, population ${number(city.population)}. Inspect ${civ?.name || 'civilization'}`} onMouseEnter={() => setHovered(city.id)} onMouseLeave={() => setHovered(null)} onFocus={() => setHovered(city.id)} onBlur={() => setHovered(null)} onClick={() => { if (moved.current) return; if (onSelectSettlement) onSelectSettlement(city.id); else onSelectCivilization(city.civId); }} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (onSelectSettlement) onSelectSettlement(city.id); else onSelectCivilization(city.civId); } }}>
            {densityRadius > 0 && <circle r={densityRadius} fill="#cee7a4" fillOpacity=".15" stroke="#cee7a4" strokeOpacity=".25"/>}
            <circle className="gmap-city-hit" r="12" fill="transparent"/>
            {capital && <circle className="gmap-city-ring" r="6"/>}
            <circle className="gmap-city-dot" r={capital ? 2.8 : 1.8}/>
            {(capital || zoom > 1.5 || index % 3 === 0) && <text x={capital ? 10 : 7} y={labelBelow ? 13 : 3} className="gmap-city-name">{city.name}</text>}
            <title>{`${city.name} · ${number(city.population)} inhabitants · ${civ?.name || ''}`}</title>
          </g>;
        })}</g>
      </g>
    </svg>
    <div className="gmap-vignette"/>
    <div className="gmap-compass" aria-hidden="true"><span>N</span><svg width="27" height="39" viewBox="0 0 27 39"><path d="M13.5 0 19 27 13.5 23 8 27Z" fill="#c5c7ac" fillOpacity=".7"/><path d="m13.5 23 3.5 13-3.5-4-3.5 4Z" fill="#c5c7ac" fillOpacity=".25"/><path d="M0 23h27M13.5 0v39" stroke="#c5c7ac" strokeOpacity=".35" strokeWidth=".7"/></svg></div>
    <div className="gmap-scale" aria-label={`Map scale ${Math.round(500 / zoom)} kilometers`}><div><span/><span/><span/></div><span>0</span><span>{Math.round(250 / zoom)}</span><span>{Math.round(500 / zoom)} km</span></div>
    <div className="gmap-legend"><span className={`gmap-legend-dot ${normalizedLayer === 'military' || normalizedLayer === 'disease' ? 'gmap-legend-dot--danger' : ''}`}/>{normalizedLayer === 'population' ? 'Settlement density' : normalizedLayer === 'economy' ? 'Wealth & trade routes' : normalizedLayer === 'religion' ? 'Dominant faith' : normalizedLayer === 'military' ? 'Military strength & conflicts' : normalizedLayer === 'climate' ? 'Regional climate' : normalizedLayer === 'disease' ? 'Active outbreaks' : normalizedLayer === 'culture' ? 'Cultural territories' : 'Civilization territories'}<span className="gmap-legend-divider"/>{geography.settlements.length} settlements</div>
    <div className="gmap-zoom" aria-label="Map zoom controls"><button type="button" onClick={() => changeZoom(.35)} disabled={zoom >= 3.5} aria-label="Zoom in" title="Zoom in">+</button><button type="button" onClick={() => changeZoom(-.35)} disabled={zoom <= 1} aria-label="Zoom out" title="Zoom out">−</button><button className="gmap-zoom-reset" type="button" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} aria-label="Reset map view" title="Reset view"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M6 2H2v4m8-4h4v4M2 10v4h4m8-4v4h-4M6 6h4v4H6Z"/></svg></button></div>
    {settlement && settlementCiv && <div className="gmap-tooltip"><span className="gmap-tooltip-label">SETTLEMENT</span><strong>{settlement.name}</strong><span>{number(settlement.population)} inhabitants · {settlementCiv.name}</span><small>Click to explore</small></div>}
  </div>;
}

export default WorldMap;
