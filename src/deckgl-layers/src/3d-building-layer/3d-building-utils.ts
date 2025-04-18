// SPDX-License-Identifier: MIT
// Copyright contributors to the kepler.gl project

import Protobuf from 'pbf';
import {VectorTile} from '@mapbox/vector-tile';
import {worldToLngLat} from 'viewport-mercator-project';
import {
  Coordinates,
  FlatFigure,
  TileDataItem,
  VectorTileFeature,
  VectorTileFeatureProperties,
  TileLoadProps
} from './types';

/* global fetch */
const TILE_SIZE = 512;

export function getTileData(
  host: string,
  tile: TileLoadProps
): Promise<TileDataItem[]> {
  const {index: {x, y, z}} = tile;
  const mapSource = `${host}/tiles/${z}/${x}/${y}.vector.pbf`;

  return fetch(mapSource)
    .then(response => {
      if (!response.ok) {
        throw new Error(`Failed to fetch tile: ${response.status} ${response.statusText}`);
      }
      return response.arrayBuffer();
    })
    .then(buffer => decodeTile(x, y, z, buffer))
    .catch(error => {
      console.error(`Error fetching or decoding tile ${x}/${y}/${z}:`, error);
      return [];
    });
}

export function decodeTile(
  x: number,
  y: number,
  z: number,
  arrayBuffer: ArrayBuffer
): TileDataItem[] {
  const tile = new VectorTile(new Protobuf(arrayBuffer));

  const result: TileDataItem[] = [];
  const xProj = x * TILE_SIZE;
  const yProj = y * TILE_SIZE;
  const scale = Math.pow(2, z);

  const projectFunc = project.bind(null, xProj, yProj, scale);

  /* eslint-disable guard-for-in */
  const layerName = 'building';
  const vectorTileLayer = tile.layers[layerName];
  if (!vectorTileLayer) {
    return [];
  }
  for (let i = 0; i < vectorTileLayer.length; i++) {
    const vectorTileFeature = vectorTileLayer.feature(i);
    // @ts-ignore
    const features = vectorTileFeatureToProp(vectorTileFeature, projectFunc);
    features.forEach(f => {
      f.properties.layer = layerName;
      if (f.properties.height) {
        result.push(f);
      }
    });
  }
  return result;
}

function project(x: number, y: number, scale: number, line: FlatFigure, extent: number): void {
  const sizeToPixel = extent / TILE_SIZE;

  for (let ii = 0; ii < line.length; ii++) {
    const p = line[ii];
    // LNGLAT
    line[ii] = worldToLngLat([x + p[0] / sizeToPixel, y + p[1] / sizeToPixel], scale);
  }
}

/* adapted from @mapbox/vector-tile/lib/vectortilefeature.js for better perf */
/* eslint-disable */
export function vectorTileFeatureToProp(
  vectorTileFeature: VectorTileFeature,
  project: (r: FlatFigure, n: number) => void
): {coordinates: FlatFigure[]; properties: VectorTileFeatureProperties}[] {
  let coords: FlatFigure[][] | FlatFigure[] = getCoordinates(vectorTileFeature);
  const extent = vectorTileFeature.extent;
  let i: number;
  let j: number;

  coords = classifyRings(coords);
  for (i = 0; i < coords.length; i++) {
    for (j = 0; j < coords[i].length; j++) {
      project(coords[i][j], extent);
    }
  }

  return coords.map(coordinates => ({
    coordinates,
    properties: vectorTileFeature.properties
  }));
}

function getCoordinates(vectorTileFeature: VectorTileFeature): FlatFigure[] {
  const pbf = vectorTileFeature._pbf;
  pbf.pos = vectorTileFeature._geometry;

  const end = pbf.readVarint() + pbf.pos;
  let cmd = 1;
  let length = 0;
  let x = 0;
  let y = 0;

  const lines: FlatFigure[] = [];
  let line: FlatFigure | undefined;

  while (pbf.pos < end) {
    if (length <= 0) {
      const cmdLen = pbf.readVarint();
      cmd = cmdLen & 0x7;
      length = cmdLen >> 3;
    }

    length--;

    if (cmd === 1 || cmd === 2) {
      x += pbf.readSVarint();
      y += pbf.readSVarint();

      if (cmd === 1) {
        // moveTo
        if (line) lines.push(line);
        line = [];
      }

      if (line) line.push([x, y]);
    } else if (cmd === 7) {
      // Workaround for https://github.com/mapbox/mapnik-vector-tile/issues/90
      if (line) {
        line.push(line[0].slice() as [number, number] | [number, number, number]); // closePolygon
      }
    } else {
      throw new Error(`unknown command ${cmd}`);
    }
  }

  if (line) lines.push(line);

  return lines;
}

// classifies an array of rings into polygons with outer rings and holes

function classifyRings(rings: FlatFigure[]): FlatFigure[][] {
  const len = rings.length;

  if (len <= 1) return [rings];

  const polygons: FlatFigure[][] = [];
  let polygon: FlatFigure[] | undefined;
  let ccw: boolean | undefined;

  for (let i = 0; i < len; i++) {
    const area = signedArea(rings[i]);
    if (area === 0) {
      continue;
    }

    if (ccw === undefined) {
      ccw = area < 0;
    }

    if (ccw === area < 0) {
      if (polygon) {
        polygons.push(polygon);
      }
      polygon = [rings[i]];
    } else if (polygon) {
      polygon.push(rings[i]);
    }
  }
  if (polygon) {
    polygons.push(polygon);
  }

  return polygons;
}

function signedArea(ring: FlatFigure): number {
  let sum = 0;
  for (let i = 0, len = ring.length, j = len - 1, p1: number[], p2: number[]; i < len; j = i++) {
    p1 = ring[i];
    p2 = ring[j];
    sum += (p2[0] - p1[0]) * (p1[1] + p2[1]);
  }
  return sum;
}
