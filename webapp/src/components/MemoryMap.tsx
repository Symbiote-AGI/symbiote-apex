import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type FormEvent } from 'react';
import ForceGraph3D, { type ForceGraph3DInstance, type LinkObject, type NodeObject } from '3d-force-graph';
import { forceCollide, forceX, forceY, forceZ } from 'd3-force-3d';
import * as THREE from 'three';
import { Activity, Download, Maximize2, Minus, Plus, Search, Send, X } from 'lucide-react';
import type { MemoryDocument, MemoryGraphData, MemoryGraphNode, MemoryNodeContext, MemoryNodeSimilarity } from '../types';
import ActivityOrb from './ActivityOrb';

type MemoryRequest = <T>(endpoint: string, options?: RequestInit) => Promise<T>;
type Side = 'system' | 'documents' | 'sessions' | 'projects';
type NodeKind = 'system' | 'domain' | 'shard' | 'document';
type GraphNode = NodeObject & {
  id: string;
  label: string;
  kind: NodeKind;
  side: Side;
  source?: string;
  parentId?: string;
  document?: MemoryGraphNode;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  anchorX: number;
  anchorY: number;
  targetX: number;
  targetY: number;
  targetZ: number;
  radius: number;
  val: number;
};
type GraphEdge = LinkObject<GraphNode> & {
  source: string;
  target: string;
  similarity: number;
  kind: 'structure' | 'similarity';
};
type GraphInstance = ForceGraph3DInstance<GraphNode, GraphEdge>;
type GraphNodeSeed = Pick<GraphNode, 'id' | 'label' | 'kind' | 'side' | 'x' | 'y' | 'anchorX' | 'anchorY' | 'radius'>
  & Partial<Pick<GraphNode, 'source' | 'parentId' | 'document'>>;
type Transform = { x: number; y: number; scale: number };

function endpointId(endpoint: string | number | GraphNode): string {
  return typeof endpoint === 'object' ? String(endpoint.id) : String(endpoint);
}

const MEMORY_COLORS = {
  symbiote: '#55c982',
  knowledge: '#50b976',
  sessions: '#5796f5',
  projects: '#e8ba4b',
  vdb: '#ed5964',
};

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function buildGraph(data: MemoryGraphData, width: number, height: number): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const centerX = width / 2;
  const centerY = height / 2;
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const addNode = (node: GraphNodeSeed) => {
    const targetX = node.x - centerX;
    const targetY = centerY - node.y;
    const depth = node.kind === 'document'
      ? ((stableHash(node.document?.id ?? node.id) % 801) - 400) * 0.3
      : node.kind === 'shard' ? ((stableHash(node.id) % 401) - 200) * 0.18 : 0;
    const jitterX = ((stableHash(`${node.id}:x`) % 1001) / 1000 - 0.5) * 16;
    const jitterY = ((stableHash(`${node.id}:y`) % 1001) / 1000 - 0.5) * 16;
    nodes.push({
      ...node,
      x: targetX + jitterX,
      y: targetY + jitterY,
      z: depth,
      vx: 0,
      vy: 0,
      vz: 0,
      targetX,
      targetY,
      targetZ: depth,
      val: node.kind === 'system' ? 2 : node.kind === 'domain' ? 1.2 : node.kind === 'shard' ? 0.8 : 0.25,
    });
  };
  addNode({
    id: 'system', label: 'SYMBIOTE', kind: 'system', side: 'system',
    x: centerX, y: centerY, anchorX: centerX, anchorY: centerY, radius: 12,
  });

  const sides: Array<{ id: Exclude<Side, 'system'>; label: string; x: number; y: number; dx: number; dy: number }> = [
    { id: 'documents', label: 'KNOWLEDGE', x: centerX - Math.min(215, width * 0.27), y: centerY, dx: -1, dy: 0 },
    { id: 'sessions', label: 'SESSIONS', x: centerX + Math.min(215, width * 0.27), y: centerY, dx: 1, dy: 0 },
    { id: 'projects', label: 'PROJECTS', x: centerX, y: centerY + Math.min(130, height * 0.26), dx: 0, dy: 1 },
  ];
  const parent = new Map(data.nodes.map(document => [document.id, document.id]));
  const find = (id: string): string => {
    const current = parent.get(id) ?? id;
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const join = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(leftRoot < rightRoot ? rightRoot : leftRoot, leftRoot < rightRoot ? leftRoot : rightRoot);
  };
  const sideById = new Map(data.nodes.map(document => [document.id, document.side]));
  const documentIds = new Set(data.nodes.map(document => document.id));
  const similarityEdges = data.edges.filter(edge =>
    edge.source !== edge.target
      && documentIds.has(edge.source)
      && documentIds.has(edge.target)
      && Number.isFinite(edge.similarity)
      && edge.similarity >= 0
      && edge.similarity <= 1,
  );
  const strongestSimilarity = new Map<string, number>();
  for (const edge of similarityEdges) {
    strongestSimilarity.set(edge.source, Math.max(strongestSimilarity.get(edge.source) ?? 0, edge.similarity));
    strongestSimilarity.set(edge.target, Math.max(strongestSimilarity.get(edge.target) ?? 0, edge.similarity));
  }
  for (const edge of similarityEdges) {
    const localBaseline = Math.min(
      strongestSimilarity.get(edge.source) ?? 0,
      strongestSimilarity.get(edge.target) ?? 0,
    );
    const clusterThreshold = Math.max(0.12, localBaseline * 0.68);
    if (edge.similarity >= clusterThreshold && sideById.get(edge.source) === sideById.get(edge.target)) {
      join(edge.source, edge.target);
    }
  }
  const components = new Map<string, MemoryGraphNode[]>();
  for (const document of data.nodes) {
    const root = find(document.id);
    const component = components.get(root) ?? [];
    component.push(document);
    components.set(root, component);
  }
  const multiDocumentComponents = [...components.entries()]
    .filter(([, documents]) => documents.length > 1)
    .sort(([left], [right]) => left.localeCompare(right));
  const componentNumbers = new Map(multiDocumentComponents.map(([root], index) => [root, index + 1]));
  const shards = new Map<string, { side: Exclude<Side, 'system'>; source: string; label: string; documents: MemoryGraphNode[] }>();
  const isolated = new Map<string, MemoryGraphNode[]>();
  for (const [root, documents] of components) {
    const side = documents[0].side;
    const sources = new Map<string, number>();
    for (const document of documents) sources.set(document.source, (sources.get(document.source) ?? 0) + 1);
    const source = [...sources].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] ?? 'other';
    if (documents.length === 1) {
      const key = `${side}\0${source}`;
      const group = isolated.get(key) ?? [];
      group.push(...documents);
      isolated.set(key, group);
    } else {
      const number = String(componentNumbers.get(root) ?? 1).padStart(2, '0');
      shards.set(`cluster:${side}:${root}`, {
        side, source, label: `${source.toUpperCase()} · ${number}`, documents,
      });
    }
  }
  for (const [key, documents] of isolated) {
    const [side, source] = key.split('\0') as [Exclude<Side, 'system'>, string];
    shards.set(`isolated:${side}:${source}`, {
      side, source, label: `${source.toUpperCase()} · OTHER`, documents,
    });
  }

  for (const side of sides) {
    const domainId = `domain:${side.id}`;
    addNode({
      id: domainId, label: side.label, kind: 'domain', side: side.id, parentId: 'system',
      x: side.x, y: side.y, anchorX: side.x, anchorY: side.y, radius: 8,
    });
    edges.push({ source: 'system', target: domainId, similarity: 1, kind: 'structure' });
    const groups = [...shards.entries()]
      .filter(([, shard]) => shard.side === side.id)
      .sort(([left], [right]) => left.localeCompare(right));
    const perpendicularX = -side.dy;
    const perpendicularY = side.dx;
    const sourceX = side.x + side.dx * 72;
    const sourceY = side.y + side.dy * 72;
    groups.forEach(([key, shard], groupIndex) => {
      const { source, documents } = shard;
      const rows = Math.max(1, groups.length);
      const offset = (groupIndex - (rows - 1) / 2) * Math.min(125, Math.max(24, width / rows * 0.12));
      const shardX = sourceX + perpendicularX * offset;
      const shardY = sourceY + perpendicularY * offset;
      const shardId = `shard:${key}`;
      addNode({
        id: shardId, label: shard.label, kind: 'shard', side: side.id, source, parentId: domainId,
        x: shardX, y: shardY, anchorX: shardX, anchorY: shardY, radius: 5,
      });
      edges.push({ source: domainId, target: shardId, similarity: 1, kind: 'structure' });
      documents.forEach(document => {
        const hash = stableHash(document.id);
        const angle = (hash % 3600) / 3600 * Math.PI * 2;
        const distance = 24 + ((hash >>> 9) % 100) / 100 * 77;
        const x = shardX + Math.cos(angle) * distance;
        const y = shardY + Math.sin(angle) * distance;
        addNode({
          id: document.id, label: document.label, kind: 'document', side: side.id,
          source: document.source, parentId: shardId, document,
          x, y, anchorX: x, anchorY: y, radius: 2.2,
        });
        edges.push({ source: shardId, target: document.id, similarity: 1, kind: 'structure' });
      });
    });
  }

  for (const edge of similarityEdges) {
    edges.push({ ...edge, kind: 'similarity' });
  }
  return { nodes, edges };
}

function sideColor(node: GraphNode): string {
  if (node.kind === 'system') return MEMORY_COLORS.symbiote;
  if (node.side === 'documents') return MEMORY_COLORS.knowledge;
  if (node.side === 'sessions') return MEMORY_COLORS.sessions;
  if (node.side === 'projects') return MEMORY_COLORS.projects;
  return MEMORY_COLORS.knowledge;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface MemoryGraphHandle {
  zoom(factor: number): void;
  fit(): void;
  save(onError: (message: string) => void): void;
}

interface MemoryGraph3DProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  shownDocuments: MemoryGraphNode[];
  selectedId: string | null;
  queryActive: boolean;
  onHover: (node: GraphNode | null) => void;
  onSelect: (node: GraphNode | null) => void;
  onError: (message: string) => void;
}

function graphBackgroundColor(color: string): string {
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/i.exec(color);
  if (!srgb) return color;
  const channels = srgb.slice(1, 4).map(channel => Math.round(Math.min(1, Math.max(0, Number(channel))) * 255));
  return `rgb(${channels.join(', ')})`;
}

const MemoryGraph3D = forwardRef<MemoryGraphHandle, MemoryGraph3DProps>(function MemoryGraph3D({
  nodes,
  edges,
  shownDocuments,
  selectedId,
  queryActive,
  onHover,
  onSelect,
  onError,
}, ref) {
  const mountRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<GraphInstance | null>(null);
  const visibleNodeIdsRef = useRef(new Set<string>());
  const positionsRef = useRef(new Map<string, { x: number; y: number; z: number }>());
  const selectedIdRef = useRef(selectedId);
  const hoveredIdRef = useRef<string | null>(null);
  const onHoverRef = useRef(onHover);
  const onSelectRef = useRef(onSelect);
  const onErrorRef = useRef(onError);
  selectedIdRef.current = selectedId;
  onHoverRef.current = onHover;
  onSelectRef.current = onSelect;
  onErrorRef.current = onError;

  useImperativeHandle(ref, () => ({
    zoom(factor) {
      const graph = graphRef.current;
      if (!graph) return;
      const camera = graph.cameraPosition();
      graph.cameraPosition({ x: camera.x * factor, y: camera.y * factor, z: camera.z * factor }, undefined, 250);
    },
    fit() {
      graphRef.current?.zoomToFit(350, 42, node => visibleNodeIdsRef.current.has(node.id));
    },
    save(onSaveError) {
      const canvas = graphRef.current?.renderer().domElement;
      if (!canvas) return;
      try {
        canvas.toBlob(blob => {
          if (!blob) {
            onSaveError('The memory map image could not be created.');
            return;
          }
          const url = URL.createObjectURL(blob);
          const link = window.document.createElement('a');
          link.href = url;
          link.download = `symbiote-memory-map-${new Date().toISOString().slice(0, 10)}.png`;
          window.document.body.append(link);
          link.click();
          link.remove();
          window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        }, 'image/png');
      } catch (failure) {
        onSaveError(failure instanceof Error ? failure.message : 'The memory map image could not be created.');
      }
    },
  }), []);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let graph: GraphInstance;
    try {
      graph = new ForceGraph3D(mount, {
        controlType: 'orbit',
        rendererConfig: { antialias: true, alpha: true, powerPreference: 'high-performance', preserveDrawingBuffer: true },
      }) as unknown as GraphInstance;
    } catch (failure) {
      onErrorRef.current(failure instanceof Error ? failure.message : 'The WebGL memory graph could not be initialized.');
      return;
    }

    const sphereGeometry = new THREE.SphereGeometry(1, 10, 8);
    const materials = new Map(
      Object.values(MEMORY_COLORS).map(color => [color, new THREE.MeshBasicMaterial({ color, toneMapped: false })]),
    );
    const linkMaterials = new Map<string, THREE.LineBasicMaterial>();
    graphRef.current = graph;

    const linkMaterial = (link: GraphEdge) => {
      const color = getComputedStyle(document.documentElement).getPropertyValue('--appearance-icon').trim() || MEMORY_COLORS.knowledge;
      const focusId = hoveredIdRef.current ?? selectedIdRef.current;
      const focused = !!focusId && (link.source === focusId || link.target === focusId
        || endpointId(link.source) === focusId || endpointId(link.target) === focusId);
      const key = `${color}:${focused ? 'focus' : 'context'}`;
      let material = linkMaterials.get(key);
      if (!material) {
        material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: focused ? 0.72 : 0.13, depthWrite: false });
        linkMaterials.set(key, material);
      }
      return material;
    };

    graph
      .backgroundColor(graphBackgroundColor(getComputedStyle(mount.parentElement ?? mount).backgroundColor) || '#101010')
      .showNavInfo(false)
      .nodeId('id')
      .nodeLabel(node => `${node.label} · ${node.source ?? node.kind} · ${node.side}`)
      .nodeColor(node => sideColor(node))
      .nodeVal(node => node.val)
      .nodeRelSize(3)
      .nodeResolution(8)
      .nodeVisibility(node => visibleNodeIdsRef.current.has(node.id))
      .nodeThreeObject(node => {
        const material = materials.get(sideColor(node));
        if (!material) throw new Error(`Missing memory graph material for ${sideColor(node)}.`);
        const mesh = new THREE.Mesh(sphereGeometry, material);
        mesh.scale.setScalar(node.kind === 'system' ? 5 : node.kind === 'domain' ? 3.2 : node.kind === 'shard' ? 2.2 : 1.15);
        return mesh;
      })
      .linkSource('source')
      .linkTarget('target')
      .linkVisibility(link => {
        if (!visibleNodeIdsRef.current.has(endpointId(link.source)) || !visibleNodeIdsRef.current.has(endpointId(link.target))) return false;
        const focusId = hoveredIdRef.current ?? selectedIdRef.current;
        if (!focusId) {
          const sourceNode = nodes.find(node => node.id === endpointId(link.source));
          const targetNode = nodes.find(node => node.id === endpointId(link.target));
          return link.kind === 'structure' && sourceNode?.kind !== 'document' && targetNode?.kind !== 'document';
        }
        return link.kind === 'structure'
          ? endpointId(link.source) === focusId || endpointId(link.target) === focusId
          : endpointId(link.source) === focusId || endpointId(link.target) === focusId;
      })
      .linkMaterial(linkMaterial)
      .linkWidth(link => {
        const focusId = hoveredIdRef.current ?? selectedIdRef.current;
        return focusId && (endpointId(link.source) === focusId || endpointId(link.target) === focusId) ? 1.1 : 0.55;
      })
      .linkResolution(4)
      .cooldownTicks(110)
      .cooldownTime(1400)
      .d3AlphaDecay(0.06)
      .d3VelocityDecay(0.44)
      .onNodeHover(node => {
        hoveredIdRef.current = node?.id ?? null;
        onHoverRef.current(node ?? null);
        graph.refresh();
      })
      .onNodeClick(node => {
        hoveredIdRef.current = node.id;
        onHoverRef.current(node);
        onSelectRef.current(node);
      })
      .onBackgroundClick(() => {
        hoveredIdRef.current = null;
        onHoverRef.current(null);
        onSelectRef.current(null);
        graph.refresh();
      });

    graph.d3Force('link')
      ?.distance((link: GraphEdge) => link.kind === 'similarity' ? 55 + (1 - link.similarity) * 62 : 82)
      .strength((link: GraphEdge) => link.kind === 'similarity' ? link.similarity ** 2 * 0.18 : 0.16);
    graph.d3Force('charge')?.strength(-84).distanceMax(280);
    graph.d3Force('center')?.strength(0.012);
    graph.d3Force('collide', forceCollide<GraphNode>(node => node.kind === 'document' ? 4.2 : node.val * 4 + 3).strength(0.7).iterations(1));
    graph.d3Force('x', forceX<GraphNode>(node => node.targetX).strength(0.08));
    graph.d3Force('y', forceY<GraphNode>(node => node.targetY).strength(0.08));
    graph.d3Force('z', forceZ<GraphNode>(node => node.targetZ).strength(0.11));

    let didAutoFit = false;
    let resizeFrame = 0;
    let previousWidth = 0;
    let previousHeight = 0;
    const resize = () => {
      const bounds = mount.getBoundingClientRect();
      const width = Math.max(1, Math.floor(bounds.width));
      const height = Math.max(1, Math.floor(bounds.height));
      if (width === previousWidth && height === previousHeight) return;
      previousWidth = width;
      previousHeight = height;
      graph.width(width).height(height);
      if (didAutoFit) {
        window.cancelAnimationFrame(resizeFrame);
        resizeFrame = window.requestAnimationFrame(() => graph.zoomToFit(180, 40, node => visibleNodeIdsRef.current.has(node.id)));
      }
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mount);
    resize();

    const themeObserver = new MutationObserver(() => {
      graph.backgroundColor(graphBackgroundColor(getComputedStyle(mount.parentElement ?? mount).backgroundColor) || '#101010');
      graph.refresh();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });

    return () => {
      window.cancelAnimationFrame(resizeFrame);
      resizeObserver.disconnect();
      themeObserver.disconnect();
      graph._destructor();
      sphereGeometry.dispose();
      for (const material of materials.values()) material.dispose();
      for (const material of linkMaterials.values()) material.dispose();
      graphRef.current = null;
    };
  }, []);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;

    const visibleIds = new Set<string>();
    const nodesById = new Map(nodes.map(node => [node.id, node]));
    if (!queryActive && shownDocuments.length === nodes.filter(node => node.kind === 'document').length) {
      for (const node of nodes) visibleIds.add(node.id);
    } else {
      visibleIds.add('system');
      for (const document of shownDocuments) {
        let current = nodesById.get(document.id);
        while (current && !visibleIds.has(current.id)) {
          visibleIds.add(current.id);
          current = current.parentId ? nodesById.get(current.parentId) : undefined;
        }
      }
    }
    visibleNodeIdsRef.current = visibleIds;

    for (const node of graph.graphData().nodes) {
      if (typeof node.x === 'number' && Number.isFinite(node.x)
        && typeof node.y === 'number' && Number.isFinite(node.y)
        && typeof node.z === 'number' && Number.isFinite(node.z)) {
        positionsRef.current.set(node.id, { x: node.x, y: node.y, z: node.z });
      }
    }
    const visibleNodes = nodes.filter(node => visibleIds.has(node.id)).map(node => {
      const position = positionsRef.current.get(node.id);
      return position ? { ...node, ...position } : { ...node };
    });
    const visibleLinks = edges.filter(link => visibleIds.has(endpointId(link.source)) && visibleIds.has(endpointId(link.target)));
    graph.graphData({ nodes: visibleNodes, links: visibleLinks });
    const frame = window.requestAnimationFrame(() => {
      if (visibleIds.size) graph.zoomToFit(320, 44, node => visibleIds.has(node.id));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [nodes, edges, shownDocuments, queryActive]);

  useEffect(() => {
    graphRef.current?.refresh();
  }, [selectedId]);

  return <div ref={mountRef} className="memory-graph3d" role="application" aria-label="Interactive three-dimensional similarity graph of indexed memory. Drag to rotate, scroll to zoom, and select a node to inspect its source." />;
});

function MemoryMap({ request, onSendNode }: {
  request: MemoryRequest;
  onSendNode?: (context: MemoryNodeContext, question: string) => void | Promise<void>;
}) {
  const shellRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const graphHandleRef = useRef<MemoryGraphHandle | null>(null);
  const graphRef = useRef<GraphNode[]>([]);
  const graphEdgesRef = useRef<GraphEdge[]>([]);
  const renderGraphRef = useRef<() => void>(() => {});
  const hoveredIdRef = useRef<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const hasAutoFitRef = useRef(false);
  const transformRef = useRef<Transform>({ x: 0, y: 0, scale: 1 });
  const [data, setData] = useState<MemoryGraphData | null>(null);
  const [selected, setSelected] = useState<MemoryDocument | null>(null);
  const [nodeQuestion, setNodeQuestion] = useState('Explain this memory and its strongest similarities.');
  const [sendingNode, setSendingNode] = useState(false);
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [hoverPosition, setHoverPosition] = useState<{ x: number; y: number } | null>(null);
  hoveredIdRef.current = hoveredId;
  selectedIdRef.current = selected?.id ?? null;

  const loadGraph = useCallback(async (showRefresh = false) => {
    if (showRefresh) setRefreshing(true);
    try {
      const graph = await request<MemoryGraphData>('/api/memory/graph');
      setData(graph);
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not load the memory map.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [request]);

  useEffect(() => {
    void loadGraph();
    const timer = window.setInterval(() => void loadGraph(), 30_000);
    return () => window.clearInterval(timer);
  }, [loadGraph]);

  const sources = useMemo(() => [...new Set(data?.nodes.map(node => node.source) ?? [])].sort(), [data]);
  const queryLower = query.trim().toLowerCase();
  const shownDocuments = useMemo(() => (data?.nodes ?? []).filter(node =>
    (sourceFilter === 'all' || (sourceFilter === 'projects' && node.side === 'projects') || node.storage === sourceFilter || node.source === sourceFilter)
    && (!queryLower || `${node.label} ${node.source} ${node.excerpt}`.toLowerCase().includes(queryLower)),
  ), [data, queryLower, sourceFilter]);
  const graphData = useMemo(
    () => data ? buildGraph(data, 1200, 760) : { nodes: [], edges: [] },
    [data],
  );
  graphRef.current = graphData.nodes;
  graphEdgesRef.current = graphData.edges;

  useEffect(() => {
    const shell = shellRef.current;
    const canvas = canvasRef.current;
    if (!shell || !canvas || !data) return;
    let width = Math.max(1, shell.clientWidth);
    let height = Math.max(1, shell.clientHeight);
    let frame = 0;
    let tick = 0;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const setSize = () => {
      const previousWidth = width;
      const previousHeight = height;
      width = Math.max(1, shell.clientWidth);
      height = Math.max(1, shell.clientHeight);
      if (hasAutoFitRef.current) {
        transformRef.current.x += (width - previousWidth) / 2;
        transformRef.current.y += (height - previousHeight) / 2;
      }
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const context = canvas.getContext('2d');
      context?.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    setSize();
    const observer = new ResizeObserver(() => {
      setSize();
      renderGraphRef.current();
    });
    observer.observe(shell);

    const graph = buildGraph(data, width, height);
    const previous = new Map(graphRef.current.map(node => [node.id, node]));
    for (const node of graph.nodes) {
      const old = previous.get(node.id);
      if (old) {
        node.x = old.x;
        node.y = old.y;
        node.anchorX = old.anchorX;
        node.anchorY = old.anchorY;
      }
    }
    graphRef.current = graph.nodes;
    graphEdgesRef.current = graph.edges;
    if (!hasAutoFitRef.current && graph.nodes.length) {
      const bounds = graph.nodes.reduce((result, node) => ({
        minX: Math.min(result.minX, node.x),
        maxX: Math.max(result.maxX, node.x),
        minY: Math.min(result.minY, node.y),
        maxY: Math.max(result.maxY, node.y),
      }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
      const graphWidth = Math.max(1, bounds.maxX - bounds.minX);
      const graphHeight = Math.max(1, bounds.maxY - bounds.minY);
      const scale = Math.max(0.3, Math.min(1.2, 1, (width - 76) / graphWidth, (height - 76) / graphHeight));
      transformRef.current = {
        x: width / 2 - (bounds.minX + bounds.maxX) / 2 * scale,
        y: height / 2 - (bounds.minY + bounds.maxY) / 2 * scale,
        scale,
      };
      hasAutoFitRef.current = true;
    }

    const render = () => {
      const context = canvas.getContext('2d');
      if (!context) return;
      const themeRoot = document.documentElement;
      const themeStyles = getComputedStyle(themeRoot);
      const canvasBackground = themeStyles.getPropertyValue('--paper-raised').trim() || themeStyles.backgroundColor;
      const ink = themeStyles.getPropertyValue('--appearance-paper-ink').trim() || themeStyles.color || '#111';
      context.clearRect(0, 0, width, height);
      context.fillStyle = canvasBackground;
      context.fillRect(0, 0, width, height);
      const transform = transformRef.current;
      context.save();
      context.translate(transform.x, transform.y);
      context.scale(transform.scale, transform.scale);

      const byId = new Map(graph.nodes.map(node => [node.id, node]));
      const visibleIds = new Set(['system', 'domain:documents', 'domain:sessions', 'domain:projects']);
      for (const document of shownDocuments) {
        visibleIds.add(document.id);
        const parentEdge = graph.edges.find(edge => edge.kind === 'structure' && edge.target === document.id);
        if (parentEdge) visibleIds.add(parentEdge.source);
      }
      const visibleEdges = graph.edges.filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target));
      const focusId = hoveredIdRef.current ?? selectedIdRef.current;
      const focusEdges = focusId ? visibleEdges.filter(edge => edge.source === focusId || edge.target === focusId) : [];
      const focusSet = new Set(focusEdges);
      for (const edge of visibleEdges) {
        const source = byId.get(edge.source);
        const target = byId.get(edge.target);
        if (!source || !target) continue;
        const focused = focusSet.has(edge);
        context.beginPath();
        context.moveTo(source.x, source.y);
        context.lineTo(target.x, target.y);
        if (edge.kind === 'similarity') {
          context.strokeStyle = focused ? MEMORY_COLORS.knowledge : ink;
          context.globalAlpha = focused ? 0.28 + edge.similarity * 0.62 : 0.025 + edge.similarity * 0.2;
          context.lineWidth = focused ? 0.85 + edge.similarity : 0.45;
        } else {
          const sourceNode = byId.get(edge.source);
          context.strokeStyle = sourceNode ? sideColor(sourceNode) : MEMORY_COLORS.symbiote;
          context.globalAlpha = focused ? 0.78 : edge.source === 'system' ? 0.38 : 0.2;
          context.lineWidth = focused ? 1.1 : edge.source === 'system' ? 1.15 : 0.75;
        }
        context.stroke();
        context.globalAlpha = 1;
      }

      context.textAlign = 'center';
      context.textBaseline = 'middle';
      for (const node of graph.nodes) {
        if (!visibleIds.has(node.id)) continue;
        const color = sideColor(node);
        const isFocused = node.id === focusId;
        const radius = node.radius * (isFocused ? 1.6 : 1);
        if (node.kind !== 'document') {
          context.beginPath();
          context.arc(node.x, node.y, radius + (node.kind === 'system' ? 11 : 5), 0, Math.PI * 2);
          context.strokeStyle = color;
          context.globalAlpha = node.kind === 'system' ? 0.24 : 0.12;
          context.lineWidth = node.kind === 'system' ? 1.2 : 0.8;
          context.stroke();
          context.globalAlpha = 1;
        }
        context.beginPath();
        context.arc(node.x, node.y, radius, 0, Math.PI * 2);
        context.fillStyle = color;
        context.globalAlpha = node.kind === 'document' && focusId && !focusEdges.some(edge => edge.source === node.id || edge.target === node.id) ? 0.38 : 0.92;
        context.fill();
        context.globalAlpha = 1;
        if (node.kind === 'document' && node.document?.storage === 'vdb') {
          context.beginPath();
          context.arc(node.x, node.y, radius + 2.1, 0, Math.PI * 2);
          context.strokeStyle = MEMORY_COLORS.vdb;
          context.globalAlpha = 0.8;
          context.lineWidth = 0.8;
          context.stroke();
          context.globalAlpha = 1;
        }

        if (node.id === focusId && transform.scale > 0.45) {
          context.font = `${node.kind === 'system' ? '600 9px' : '500 8px'} 'Cascadia Code', Consolas, monospace`;
          context.fillStyle = ink;
          context.fillText(node.label.slice(0, 42), node.x, node.y - radius - 10);
        }
      }
      context.restore();

      if (!reducedMotion && tick < 150 && graph.nodes.length <= 5000) {
        tick++;
        const cellSize = 42;
        const grid = new Map<string, GraphNode[]>();
        const nodeIndexes = new Map(graph.nodes.map((node, index) => [node, index]));
        for (const node of graph.nodes) {
          const key = `${Math.floor(node.x / cellSize)},${Math.floor(node.y / cellSize)}`;
          const cell = grid.get(key) ?? [];
          cell.push(node);
          grid.set(key, cell);
        }
        for (let nodeIndex = 0; nodeIndex < graph.nodes.length; nodeIndex++) {
          const node = graph.nodes[nodeIndex];
          if (node.kind === 'system') continue;
          const cellX = Math.floor(node.x / cellSize);
          const cellY = Math.floor(node.y / cellSize);
          for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
              for (const other of grid.get(`${cellX + dx},${cellY + dy}`) ?? []) {
                const otherIndex = nodeIndexes.get(other) ?? -1;
                if (otherIndex <= nodeIndex) continue;
                const differenceX = node.x - other.x;
                const differenceY = node.y - other.y;
                const distanceSquared = differenceX * differenceX + differenceY * differenceY;
                if (distanceSquared > 0 && distanceSquared < cellSize * cellSize) {
                  const force = (node.kind === 'document' && other.kind === 'document' ? 2.8 : 6) / distanceSquared;
                  node.vx += differenceX * force;
                  node.vy += differenceY * force;
                  other.vx -= differenceX * force;
                  other.vy -= differenceY * force;
                }
              }
            }
          }
        }
        for (const edge of graph.edges) {
          const source = byId.get(edge.source);
          const target = byId.get(edge.target);
          if (!source || !target || edge.kind === 'similarity' && edge.similarity < 0.16) continue;
          const differenceX = target.x - source.x;
          const differenceY = target.y - source.y;
          const distance = Math.max(1, Math.hypot(differenceX, differenceY));
          const targetDistance = edge.kind === 'similarity' ? 55 + (1 - edge.similarity) * 62 : 88;
          const force = edge.kind === 'similarity' ? edge.similarity * 0.004 : 0.009;
          const attraction = (distance - targetDistance) * force;
          if (source.kind !== 'system') {
            source.vx += differenceX / distance * attraction;
            source.vy += differenceY / distance * attraction;
          }
          if (target.kind !== 'system') {
            target.vx -= differenceX / distance * attraction;
            target.vy -= differenceY / distance * attraction;
          }
        }
        for (const node of graph.nodes) {
          const anchorForce = node.kind === 'system' ? 0 : node.kind === 'document' ? 0.006 : 0.02;
          node.vx += (node.anchorX - node.x) * anchorForce;
          node.vy += (node.anchorY - node.y) * anchorForce;
          node.vx *= 0.84;
          node.vy *= 0.84;
          node.x += Math.max(-3, Math.min(3, node.vx));
          node.y += Math.max(-3, Math.min(3, node.vy));
        }
        frame = window.requestAnimationFrame(render);
      }
    };
    renderGraphRef.current = render;
    render();
    const themeObserver = new MutationObserver(() => renderGraphRef.current());
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      themeObserver.disconnect();
    };
  }, [data, shownDocuments]);

  const selectNode = async (node: GraphNode | null) => {
    if (!node?.document) {
      setSelected(null);
      return;
    }
    try {
      const document = await request<MemoryDocument>(`/api/memory/documents/${encodeURIComponent(node.id)}`);
      setSelected(document);
      selectedIdRef.current = document.id;
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not load this memory document.');
    }
  };

  const sendSelectedNode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const question = nodeQuestion.trim();
    if (!selected || !data || !onSendNode || !question || sendingNode) return;

    const strongestByNode = new Map<string, number>();
    for (const edge of data.edges) {
      if (edge.source !== selected.id && edge.target !== selected.id) continue;
      const relatedId = edge.source === selected.id ? edge.target : edge.source;
      if (relatedId === selected.id) continue;
      strongestByNode.set(relatedId, Math.max(strongestByNode.get(relatedId) ?? 0, edge.similarity));
    }
    const nodesById = new Map(data.nodes.map(node => [node.id, node]));
    const similarities: MemoryNodeSimilarity[] = [...strongestByNode]
      .flatMap(([id, similarity]) => {
        const node = nodesById.get(id);
        return node ? [{ ...node, similarity }] : [];
      })
      .sort((left, right) => right.similarity - left.similarity);
    const meanSimilarity = similarities.length
      ? similarities.reduce((total, node) => total + node.similarity, 0) / similarities.length
      : 0;
    const context: MemoryNodeContext = {
      selected,
      graph: {
        nodeCount: data.nodes.length,
        similarityCount: similarities.length,
        meanSimilarity,
        strongestSimilarity: similarities[0]?.similarity ?? null,
        similarities: similarities.slice(0, 20),
      },
    };

    setSendingNode(true);
    try {
      await onSendNode(context, question);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not send this memory to the agent.');
    } finally {
      setSendingNode(false);
    }
  };

  const resetMap = () => {
    graphHandleRef.current?.fit();
  };

  const saveImage = () => {
    graphHandleRef.current?.save(setError);
  };

  const updateZoom = (factor: number) => {
    graphHandleRef.current?.zoom(factor);
  };

  const stats = data?.stats;
  const hoveredNode = hoveredId ? graphRef.current.find(node => node.id === hoveredId) : null;
  const hoveredDocumentCount = hoveredNode
    ? graphEdgesRef.current.filter(edge => edge.kind === 'structure' && edge.source === hoveredNode.id).length
    : 0;
  const hoveredSimilarCount = hoveredNode
    ? graphEdgesRef.current.filter(edge => edge.source === hoveredNode.id || edge.target === hoveredNode.id).length
    : 0;
  const sessionCount = data?.nodes.filter(node => node.side === 'sessions').length ?? 0;
  const projectCount = data?.nodes.filter(node => node.side === 'projects').length ?? 0;
  const documentCount = data?.nodes.length ? data.nodes.length - sessionCount - projectCount : 0;

  return (
    <div className="page memory-page">
      <header className="memory-heading">
        <div><div className="eyebrow">PERSISTENT KNOWLEDGE · LIVE SIMILARITY</div><h1>Memory map</h1><p>Indexed from {data?.storage ?? '.vdb/'} · Knowledge, sessions, and project work stay distinct and connect through semantic similarity.</p></div>
        <button className="button button-secondary memory-export" type="button" onClick={saveImage} disabled={!data?.nodes.length}><Download size={15} />Save as image</button>
      </header>

      {error && <div className="notice notice-error memory-error" role="alert"><span>{error}</span><button type="button" className="icon-button small" onClick={() => void loadGraph(true)} aria-label="Retry memory map"><Activity size={14} /></button></div>}

      <section className="memory-overview" aria-label="Memory index statistics">
        <div><span>VDB DOCUMENTS</span><strong>{stats?.documentCount ?? '—'}</strong></div>
        <div><span>KNOWLEDGE</span><strong>{documentCount.toLocaleString()}</strong></div>
        <div><span>SESSION MEMORY</span><strong>{sessionCount.toLocaleString()}</strong></div>
        <div><span>PROJECT MEMORY</span><strong>{projectCount.toLocaleString()}</strong></div>
        <div><span>VOCABULARY</span><strong>{stats?.termCount.toLocaleString() ?? '—'}</strong></div>
        <div><span>INDEX SIZE</span><strong>{stats ? formatBytes(stats.diskBytes) : '—'}</strong></div>
      </section>

      <section className="memory-map-card surface-card">
        <div className="memory-toolbar">
          <label className="search-field memory-search"><Search size={15} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a memory…" aria-label="Search memory map" />{query && <button className="icon-button small" onClick={() => setQuery('')} aria-label="Clear search"><X size={13} /></button>}</label>
          <label className="memory-source-filter"><span className="sr-only">Filter by source</span><select value={sourceFilter} onChange={event => setSourceFilter(event.target.value)}><option value="all">All sources</option><option value="vdb">.vdb vector store</option><option value="projects">Projects</option>{sources.map(source => <option key={source} value={source}>{source}</option>)}</select></label>
          <span className={`memory-refresh-label${refreshing ? ' is-refreshing' : ''}`}>{refreshing && <ActivityOrb label="Synchronizing memory" compact loading />}{refreshing ? 'SYNCING' : stats ? `${shownDocuments.length.toLocaleString()} / ${stats.documentCount.toLocaleString()} NODES` : loading ? 'INDEXING' : 'NO INDEX'}</span>
        </div>
        <div className="memory-map-shell" ref={shellRef}>
          {loading && <div className="memory-loading"><ActivityOrb label="Loading indexed knowledge" loading /><span>Loading indexed knowledge…</span></div>}
          {!loading && !data?.nodes.length && <div className="memory-empty">No indexed knowledge yet. Memory documents, sessions, and project files appear here as they are synchronized.</div>}
          {data && (
            <MemoryGraph3D
              ref={graphHandleRef}
              nodes={graphData.nodes}
              edges={graphData.edges}
              shownDocuments={shownDocuments}
              selectedId={selected?.id ?? null}
              queryActive={sourceFilter !== 'all' || queryLower.length > 0}
              onHover={node => {
                hoveredIdRef.current = node?.id ?? null;
                setHoveredId(node?.id ?? null);
                setHoverPosition(node ? { x: 14, y: 58 } : null);
              }}
              onSelect={node => void selectNode(node)}
              onError={setError}
            />
          )}
          {data?.nodes.length ? (
            <>
              <div className="memory-map-legend"><span><i className="legend-dot legend-docs" />Knowledge</span><span><i className="legend-dot legend-sessions" />Sessions</span><span><i className="legend-dot legend-projects" />Projects</span><span><i className="legend-vdb" />.vdb storage</span><span><i className="legend-link" />Similarity</span></div>
              <div className="memory-zoom-controls">
                <button type="button" onClick={() => updateZoom(1.2)} aria-label="Zoom in"><Plus size={15} /></button>
                <button type="button" onClick={() => updateZoom(0.84)} aria-label="Zoom out"><Minus size={15} /></button>
                <button type="button" onClick={resetMap} aria-label="Fit map to view"><Maximize2 size={14} /></button>
              </div>
              <div className="memory-map-side-label memory-map-left">KNOWLEDGE</div>
              <div className="memory-map-side-label memory-map-right">SESSIONS</div>
              <div className="memory-map-side-label memory-map-bottom">PROJECT MEMORY</div>
            </>
          ) : null}
          {hoveredNode && hoverPosition && (
            <aside className="memory-hover-card" style={{ left: hoverPosition.x, top: hoverPosition.y }} aria-live="polite">
              <strong>{hoveredNode.label}</strong>
              <span>{hoveredNode.source ?? hoveredNode.kind} · {hoveredNode.side}</span>
              {hoveredNode.document?.excerpt && <p>{hoveredNode.document.excerpt}</p>}
              <small>{hoveredNode.kind === 'shard' ? `${hoveredDocumentCount} documents · ` : ''}{hoveredSimilarCount} connections{hoveredNode.document?.timestamp ? ` · ${new Date(hoveredNode.document.timestamp).toLocaleDateString()}` : ''}</small>
            </aside>
          )}
        </div>
        {selected && (
          <aside className="memory-detail" aria-label="Selected memory document">
            <div className="memory-detail-heading"><div><div className="eyebrow">{selected.source} · {selected.role}</div><h2>{selected.label}</h2></div><button className="icon-button small" type="button" onClick={() => { setSelected(null); selectedIdRef.current = null; renderGraphRef.current(); }} aria-label="Close memory details"><X size={15} /></button></div>
            <p>{selected.text}</p>
            <div className="memory-detail-meta"><span>{new Date(selected.timestamp).toLocaleString()}</span>{selected.sessionId && <span>Session {selected.sessionId}</span>}</div>
            {onSendNode && <form className="memory-agent-question" onSubmit={event => void sendSelectedNode(event)}>
              <label className="sr-only" htmlFor="memory-agent-question">Ask the agent about this memory</label>
              <input
                id="memory-agent-question"
                value={nodeQuestion}
                onChange={event => setNodeQuestion(event.target.value)}
                placeholder="Ask the agent about this memory…"
                maxLength={1000}
                disabled={sendingNode}
              />
              <button className="button button-primary" type="submit" disabled={sendingNode || !nodeQuestion.trim()}>
                <Send size={13} />{sendingNode ? 'Sending…' : 'Ask agent'}
              </button>
            </form>}
          </aside>
        )}
        <div className="memory-card-footer"><span><i className="memory-live-dot" />Shared VDB · {refreshing ? 'updating' : 'refreshes every 30 seconds'}</span><span>Drag to explore · Scroll to zoom · Select a node for its source</span></div>
      </section>

    </div>
  );
}

export default MemoryMap;
