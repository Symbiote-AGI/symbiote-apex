import { Map as MapLibreMap, NavigationControl, setWorkerUrl, type MapMouseEvent, type Source, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { VectorEntity } from '../../../src/resource-aggregator/types.js';

setWorkerUrl(mapLibreWorkerUrl);

type LayerMode = 'dark' | 'satellite';
type ProjectionMode = 'mercator' | 'globe';
type SimilarEntity = VectorEntity & { score: number };
type PointProperties = {
  id: string;
  sourceId: string;
  label: string;
  selected: boolean;
  similar: boolean;
};
type PointFeatureCollection = {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    id: string;
    properties: PointProperties;
    geometry: { type: 'Point'; coordinates: [number, number] };
  }>;
};
type LineFeatureCollection = {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    id: string;
    properties: { score: number };
    geometry: { type: 'LineString'; coordinates: Array<[number, number]> };
  }>;
};
type MutableGeoJSONSource = Source & {
  setData(data: PointFeatureCollection | LineFeatureCollection): Promise<void>;
};

const POINT_SOURCE = 'intelligence-records';
const LINK_SOURCE = 'intelligence-similarities';
const POINT_LAYER = 'intelligence-record-points';
const CLUSTER_LAYER = 'intelligence-record-clusters';

function rasterStyle(mode: LayerMode): StyleSpecification | string {
  if (mode === 'dark') return 'https://tiles.openfreemap.org/styles/dark';

  return {
    version: 8,
    sources: {
      base: {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
      },
    },
    layers: [{ id: 'base-raster', type: 'raster', source: 'base', minzoom: 0, maxzoom: 22 }],
  };
}

function hasCoordinates(entity: VectorEntity): entity is VectorEntity & { latitude: number; longitude: number } {
  return typeof entity.latitude === 'number'
    && Number.isFinite(entity.latitude)
    && entity.latitude >= -90
    && entity.latitude <= 90
    && typeof entity.longitude === 'number'
    && Number.isFinite(entity.longitude)
    && entity.longitude >= -180
    && entity.longitude <= 180;
}

function createPointData(
  entities: VectorEntity[],
  selectedId: string | null,
  similarIds: Set<string>,
): PointFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: entities.filter(hasCoordinates).map(entity => {
      const sourceSeparator = entity.id.indexOf(':');
      return {
        type: 'Feature',
        id: entity.id,
        properties: {
          id: entity.id,
          sourceId: sourceSeparator < 0 ? entity.id : entity.id.slice(0, sourceSeparator),
          label: entity.label ?? entity.recordId ?? entity.id,
          selected: entity.id === selectedId,
          similar: similarIds.has(entity.id),
        },
        geometry: { type: 'Point', coordinates: [entity.longitude, entity.latitude] },
      };
    }),
  };
}

function greatCircleCoordinates(
  from: [number, number],
  to: [number, number],
): Array<[number, number]> {
  const radians = Math.PI / 180;
  const toVector = ([longitude, latitude]: [number, number]): [number, number, number] => {
    const lat = latitude * radians;
    const lon = longitude * radians;
    return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  };
  const start = toVector(from);
  const end = toVector(to);
  const cosine = Math.max(-1, Math.min(1, start[0] * end[0] + start[1] * end[1] + start[2] * end[2]));
  const angle = Math.acos(cosine);
  const steps = 32;

  if (angle < 1e-6) return [from, to];
  if (Math.abs(Math.sin(angle)) < 1e-6) {
    return Array.from({ length: steps + 1 }, (_, index) => {
      const progress = index / steps;
      return [
        from[0] + (to[0] - from[0]) * progress,
        from[1] + (to[1] - from[1]) * progress,
      ];
    });
  }

  return Array.from({ length: steps + 1 }, (_, index) => {
    const progress = index / steps;
    const startWeight = Math.sin((1 - progress) * angle) / Math.sin(angle);
    const endWeight = Math.sin(progress * angle) / Math.sin(angle);
    const x = start[0] * startWeight + end[0] * endWeight;
    const y = start[1] * startWeight + end[1] * endWeight;
    const z = start[2] * startWeight + end[2] * endWeight;
    const longitude = Math.atan2(y, x) / radians;
    const latitude = Math.atan2(z, Math.hypot(x, y)) / radians;
    return [longitude, latitude];
  });
}

function createLinkData(selected: VectorEntity | null, similar: SimilarEntity[]): LineFeatureCollection {
  if (!selected || !hasCoordinates(selected)) return { type: 'FeatureCollection', features: [] };
  return {
    type: 'FeatureCollection',
    features: similar.flatMap(match => {
      if (!hasCoordinates(match)) return [];
      return [{
        type: 'Feature' as const,
        id: `${selected.id}->${match.id}`,
        properties: { score: match.score },
        geometry: {
          type: 'LineString' as const,
          coordinates: greatCircleCoordinates(
            [selected.longitude, selected.latitude],
            [match.longitude, match.latitude],
          ),
        },
      }];
    }),
  };
}

function installRecordLayers(
  map: MapLibreMap,
  pointData: PointFeatureCollection,
  linkData: LineFeatureCollection,
  onDataError: (failure: unknown) => void,
): void {
  if (!map.getSource(POINT_SOURCE)) {
    map.addSource(POINT_SOURCE, {
      type: 'geojson',
      data: pointData,
      cluster: true,
      clusterMaxZoom: 6,
      clusterRadius: 42,
    });
    map.addSource(LINK_SOURCE, { type: 'geojson', data: linkData });
    map.addLayer({
      id: 'intelligence-similarity-lines',
      type: 'line',
      source: LINK_SOURCE,
      paint: {
        'line-color': '#61d8b5',
        'line-width': 1.5,
        'line-opacity': 0.72,
      },
    });
    map.addLayer({
      id: CLUSTER_LAYER,
      type: 'circle',
      source: POINT_SOURCE,
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': '#72cdb3',
        'circle-opacity': 0.72,
        'circle-radius': ['step', ['get', 'point_count'], 13, 30, 18, 200, 24],
        'circle-stroke-color': '#d8fff2',
        'circle-stroke-width': 1,
      },
    });
    map.addLayer({
      id: POINT_LAYER,
      type: 'circle',
      source: POINT_SOURCE,
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': [
          'case',
          ['boolean', ['get', 'selected'], false], '#ffc66d',
          ['boolean', ['get', 'similar'], false], '#61d8b5',
          ['match', ['get', 'sourceId'],
            'opensky-aircraft', '#75cfff',
            'usgs-earthquakes-2-5-day', '#ff857d',
            'noaa-planetary-k-index', '#c4a4ff',
            'noaa-goes-xray-flares', '#ffbb72',
            '#85cfb8'],
        ],
        'circle-radius': [
          'case',
          ['boolean', ['get', 'selected'], false], 8,
          ['boolean', ['get', 'similar'], false], 6,
          4,
        ],
        'circle-opacity': 0.9,
        'circle-stroke-color': '#f8fafc',
        'circle-stroke-width': ['case', ['boolean', ['get', 'selected'], false], 2, 1],
      },
    });
  } else {
    const pointSource = map.getSource<MutableGeoJSONSource>(POINT_SOURCE);
    const linkSource = map.getSource<MutableGeoJSONSource>(LINK_SOURCE);
    if (!pointSource || !linkSource) {
      onDataError(new Error('The intelligence map data layers could not be updated.'));
      return;
    }
    void pointSource.setData(pointData).catch(onDataError);
    void linkSource.setData(linkData).catch(onDataError);
  }
}

export default function IntelligenceMapGL({
  entities,
  selected,
  similar,
  layer,
  projection,
  onSelect,
}: {
  entities: VectorEntity[];
  selected: VectorEntity | null;
  similar: SimilarEntity[];
  layer: LayerMode;
  projection: ProjectionMode;
  onSelect: (id: string | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const projectionRef = useRef(projection);
  const onSelectRef = useRef(onSelect);
  const [mapError, setMapError] = useState('');
  const similarIds = useMemo(() => new Set(similar.map(entity => entity.id)), [similar]);
  const pointData = useMemo(() => createPointData(entities, selected?.id ?? null, similarIds), [entities, selected?.id, similarIds]);
  const linkData = useMemo(() => createLinkData(selected, similar), [selected, similar]);
  const pointDataRef = useRef(pointData);
  const linkDataRef = useRef(linkData);

  projectionRef.current = projection;
  onSelectRef.current = onSelect;
  pointDataRef.current = pointData;
  linkDataRef.current = linkData;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let map: MapLibreMap;
    try {
      map = new MapLibreMap({
        container,
        style: rasterStyle(layer),
        center: [0, 20],
        zoom: 1.35,
        minZoom: 1,
        maxZoom: 16,
        attributionControl: {
          compact: true,
        },
      });
    } catch (failure) {
      setMapError(failure instanceof Error ? failure.message : String(failure));
      return;
    }

    mapRef.current = map;
    map.addControl(new NavigationControl({ showCompass: true }), 'top-right');
    const applyStyle = () => {
      map.setProjection({ type: projectionRef.current });
      installRecordLayers(map, pointDataRef.current, linkDataRef.current, failure => {
        setMapError(failure instanceof Error ? failure.message : String(failure));
      });
      setMapError('');
    };
    const onClick = (event: MapMouseEvent) => {
      const layers = [CLUSTER_LAYER, POINT_LAYER].filter(id => map.getLayer(id));
      if (!layers.length) return;
      const feature = map.queryRenderedFeatures(event.point, { layers })[0];
      if (!feature) {
        onSelectRef.current(null);
        return;
      }

      const properties = feature.properties;
      if (typeof properties?.point_count === 'number' && feature.geometry.type === 'Point') {
        const [longitude, latitude] = feature.geometry.coordinates;
        map.easeTo({
          center: [longitude, latitude],
          zoom: Math.min(map.getZoom() + 2, 9),
          duration: 450,
        });
        return;
      }
      const id = properties?.id;
      onSelectRef.current(typeof id === 'string' ? id : null);
    };
    const onMove = (event: MapMouseEvent) => {
      const layers = [CLUSTER_LAYER, POINT_LAYER].filter(id => map.getLayer(id));
      const hits = layers.length ? map.queryRenderedFeatures(event.point, { layers }) : [];
      map.getCanvas().style.cursor = hits.length ? 'pointer' : '';
    };
    const onStyleLoad = () => {
      try {
        applyStyle();
      } catch (failure) {
        setMapError(failure instanceof Error ? failure.message : String(failure));
      }
    };

    map.on('style.load', onStyleLoad);
    map.on('click', onClick);
    map.on('mousemove', onMove);
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(container);

    if (map.isStyleLoaded()) onStyleLoad();
    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.setStyle(rasterStyle(layer));
  }, [layer]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    map.setProjection({ type: projection });
  }, [projection]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    let active = true;
    const reportError = (failure: unknown) => {
      setMapError(failure instanceof Error ? failure.message : String(failure));
    };
    const install = () => {
      if (!active) return;
      if (!map.isStyleLoaded()) {
        map.once('idle', install);
        return;
      }
      try {
        installRecordLayers(map, pointData, linkData, reportError);
        setMapError('');
      } catch (failure) {
        reportError(failure);
      }
    };

    install();
    return () => {
      active = false;
      map.off('idle', install);
    };
  }, [pointData, linkData]);

  return (
    <div className="intelligence-map-shell">
      <div ref={containerRef} className="intelligence-map-webgl" aria-label="Geolocated public intelligence records" />
      {mapError && <div className="intelligence-map-error" role="alert">{mapError}</div>}
      <div className="intelligence-map-key" aria-hidden="true">
        <span><i className="intelligence-map-key-aircraft" />Aircraft</span>
        <span><i className="intelligence-map-key-earth" />Earth events</span>
        {selected && <span><i className="intelligence-map-key-similar" />Selected similarities</span>}
      </div>
    </div>
  );
}
