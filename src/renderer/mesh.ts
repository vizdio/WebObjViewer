import type { Vec3 } from './math'

export type TriangleUv = [[number, number], [number, number], [number, number]]

export interface TextureBufferData {
  width: number
  height: number
  data: Uint8ClampedArray
}

export interface Mesh {
  name: string
  vertices: Vec3[]
  triangles: Array<[number, number, number]>
  color: string
  triangleColors?: string[]
  triangleTextureCoords?: Array<TriangleUv | null>
  textureData?: TextureBufferData
  emissive?: boolean
  doubleSided?: boolean
}

export interface Transform {
  position: Vec3
  rotation: Vec3
  scale: Vec3
}

export interface SceneObject {
  mesh: Mesh
  transform: Transform
}

export function createTransform(
  position: Vec3,
  rotation: Vec3,
  scale: Vec3,
): Transform {
  return { position, rotation, scale }
}

export function createCubeMesh(name = 'Cube', color = '#7bdcff'): Mesh {
  return {
    name,
    color,
    vertices: [
      [-1, -1, -1],
      [1, -1, -1],
      [1, 1, -1],
      [-1, 1, -1],
      [-1, -1, 1],
      [1, -1, 1],
      [1, 1, 1],
      [-1, 1, 1],
    ],
    triangles: [
      [0, 2, 1],
      [0, 3, 2],
      [4, 5, 6],
      [4, 6, 7],
      [0, 1, 5],
      [0, 5, 4],
      [2, 3, 7],
      [2, 7, 6],
      [0, 4, 7],
      [0, 7, 3],
      [1, 2, 6],
      [1, 6, 5],
    ],
  }
}

export function createPyramidMesh(name = 'Pyramid', color = '#ffb86b'): Mesh {
  return {
    name,
    color,
    vertices: [
      [-1, -1, -1],
      [1, -1, -1],
      [1, -1, 1],
      [-1, -1, 1],
      [0, 1.3, 0],
    ],
    triangles: [
      [0, 1, 2],
      [0, 2, 3],
      [0, 4, 1],
      [1, 4, 2],
      [2, 4, 3],
      [3, 4, 0],
    ],
  }
}

export function createOctahedronMesh(name = 'Octahedron', color = '#95f28f'): Mesh {
  return {
    name,
    color,
    vertices: [
      [0, 1.3, 0],
      [1.1, 0, 0],
      [0, 0, 1.1],
      [-1.1, 0, 0],
      [0, 0, -1.1],
      [0, -1.3, 0],
    ],
    triangles: [
      [0, 2, 1],
      [0, 3, 2],
      [0, 4, 3],
      [0, 1, 4],
      [5, 1, 2],
      [5, 2, 3],
      [5, 3, 4],
      [5, 4, 1],
    ],
  }
}

export function createLightMarkerMesh(name = 'Light Marker', color = '#fff4b8'): Mesh {
  return {
    name,
    color,
    emissive: true,
    vertices: [
      [0, 1, 0],
      [0.894, 0.447, 0],
      [0.276, 0.447, 0.851],
      [-0.724, 0.447, 0.526],
      [-0.724, 0.447, -0.526],
      [0.276, 0.447, -0.851],
      [0.724, -0.447, 0.526],
      [-0.276, -0.447, 0.851],
      [-0.894, -0.447, 0],
      [-0.276, -0.447, -0.851],
      [0.724, -0.447, -0.526],
      [0, -1, 0],
    ],
    triangles: [
      [0, 1, 2],
      [0, 2, 3],
      [0, 3, 4],
      [0, 4, 5],
      [0, 5, 1],
      [1, 6, 2],
      [2, 7, 3],
      [3, 8, 4],
      [4, 9, 5],
      [5, 10, 1],
      [1, 10, 6],
      [2, 6, 7],
      [3, 7, 8],
      [4, 8, 9],
      [5, 9, 10],
      [6, 11, 7],
      [7, 11, 8],
      [8, 11, 9],
      [9, 11, 10],
      [10, 11, 6],
    ],
  }
}
