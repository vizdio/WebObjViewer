import type { Mesh, TriangleUv } from './mesh'
import type { Vec3 } from './math'

export interface TextureData {
  width: number
  height: number
  data: Uint8ClampedArray
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function rgbToHex(red: number, green: number, blue: number): string {
  const toHex = (value: number) => value.toString(16).padStart(2, '0')
  return `#${toHex(red)}${toHex(green)}${toHex(blue)}`
}

export interface ParsedMtlMaterial {
  diffuseColor?: string
  diffuseMapPath?: string
}

export function normalizeResourceName(pathLike: string): string {
  const normalized = pathLike.replace(/\\/g, '/').trim().toLowerCase()
  const parts = normalized.split('/')
  return parts[parts.length - 1] ?? normalized
}

function parseVertexIndex(token: string, vertexCount: number): number {
  const index = Number.parseInt(token, 10)
  if (Number.isNaN(index) || index === 0) {
    throw new Error(`Invalid OBJ index: ${token}`)
  }

  return index > 0 ? index - 1 : vertexCount + index
}

function triangulateFace(indices: number[]): Array<[number, number, number]> {
  const triangles: Array<[number, number, number]> = []

  for (let index = 1; index < indices.length - 1; index += 1) {
    triangles.push([indices[0], indices[index], indices[index + 1]])
  }

  return triangles
}

function parseTextureIndex(token: string, textureCount: number): number {
  const index = Number.parseInt(token, 10)
  if (Number.isNaN(index) || index === 0) {
    return -1
  }

  return index > 0 ? index - 1 : textureCount + index
}

function triangulateFaceWithIndices<T>(indices: T[]): Array<[T, T, T]> {
  const triangles: Array<[T, T, T]> = []

  for (let index = 1; index < indices.length - 1; index += 1) {
    const a = indices[0]
    const b = indices[index]
    const c = indices[index + 1]
    if (a !== undefined && b !== undefined && c !== undefined) {
      triangles.push([a, b, c])
    }
  }

  return triangles
}

function parseMapPath(tokens: string[]): string {
  if (tokens.length <= 1) {
    return ''
  }

  const valueTokens = tokens.slice(1)
  if (valueTokens[0]?.startsWith('-')) {
    return valueTokens[valueTokens.length - 1] ?? ''
  }

  return valueTokens.join(' ').trim()
}

export function parseObjMesh(
  text: string,
  name = 'Imported OBJ',
  color = '#ffffff',
  materials: Record<string, ParsedMtlMaterial> = {},
  textures: Record<string, TextureData> = {},
): Mesh {
  const vertices: Vec3[] = []
  const textureCoords: Array<[number, number]> = []
  const triangles: Array<[number, number, number]> = []
  const triangleColors: string[] = []
  const triangleTextureCoords: Array<TriangleUv | null> = []
  const lines = text.split(/\r?\n/)
  let activeMaterial = ''
  let meshTextureData: TextureData | undefined

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) {
      continue
    }

    const tokens = line.split(/\s+/)
    const type = tokens[0]

    if (type === 'v') {
      const x = Number.parseFloat(tokens[1] ?? '0')
      const y = Number.parseFloat(tokens[2] ?? '0')
      const z = Number.parseFloat(tokens[3] ?? '0')
      vertices.push([x, y, z])
      continue
    }

    if (type === 'vt') {
      const u = Number.parseFloat(tokens[1] ?? '0')
      const v = Number.parseFloat(tokens[2] ?? '0')
      textureCoords.push([u, v])
      continue
    }

    if (type === 'f') {
      const faceVertexIndices: number[] = []
      const faceTextureIndices: number[] = []

      for (const token of tokens.slice(1)) {
        const [vertexToken, textureToken] = token.split('/')
        faceVertexIndices.push(parseVertexIndex(vertexToken ?? '', vertices.length))
        if (textureToken !== undefined && textureToken.length > 0) {
          faceTextureIndices.push(parseTextureIndex(textureToken, textureCoords.length))
        }
      }

      if (faceVertexIndices.length >= 3) {
        const faceTriangles = triangulateFace(faceVertexIndices)
        triangles.push(...faceTriangles)

        const material = materials[activeMaterial]
        const materialColor = material?.diffuseColor ?? color
        const texturePath = material?.diffuseMapPath
        const texture = texturePath !== undefined ? textures[normalizeResourceName(texturePath)] : undefined
        if (meshTextureData === undefined && texture !== undefined) {
          meshTextureData = texture
        }

        if (
          faceTextureIndices.length === faceVertexIndices.length &&
          texture !== undefined &&
          meshTextureData === texture
        ) {
          const uvTriangles = triangulateFaceWithIndices(faceTextureIndices)
          for (const [uvAIndex, uvBIndex, uvCIndex] of uvTriangles) {
            const uvA = textureCoords[uvAIndex]
            const uvB = textureCoords[uvBIndex]
            const uvC = textureCoords[uvCIndex]
            if (uvA !== undefined && uvB !== undefined && uvC !== undefined) {
              triangleTextureCoords.push([uvA, uvB, uvC])
            } else {
              triangleTextureCoords.push(null)
            }
            triangleColors.push(materialColor)
          }
        } else {
          for (let index = 0; index < faceTriangles.length; index += 1) {
            triangleColors.push(materialColor)
            triangleTextureCoords.push(null)
          }
        }
      }

      continue
    }

    if (type === 'usemtl') {
      activeMaterial = tokens.slice(1).join(' ').trim()
    }
  }

  if (vertices.length === 0 || triangles.length === 0) {
    throw new Error('The OBJ file did not contain any renderable faces.')
  }

  return {
    name,
    vertices,
    triangles,
    color,
    triangleColors: triangleColors.length === triangles.length ? triangleColors : undefined,
    triangleTextureCoords:
      triangleTextureCoords.length === triangles.length ? triangleTextureCoords : undefined,
    textureData: meshTextureData,
    doubleSided: true,
  }
}

export function parseObjMaterialLibraries(text: string): string[] {
  const lines = text.split(/\r?\n/)
  const libraries: string[] = []

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) {
      continue
    }

    const tokens = line.split(/\s+/)
    if ((tokens[0] ?? '').toLowerCase() !== 'mtllib') {
      continue
    }

    const libraryName = tokens.slice(1).join(' ').trim()
    if (libraryName.length > 0) {
      libraries.push(libraryName)
    }
  }

  return libraries
}

export function parseMtlMaterials(text: string): Record<string, ParsedMtlMaterial> {
  const materials: Record<string, ParsedMtlMaterial> = {}
  const lines = text.split(/\r?\n/)
  let activeMaterial = ''

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) {
      continue
    }

    const tokens = line.split(/\s+/)
    const type = (tokens[0] ?? '').toLowerCase()

    if (type === 'newmtl') {
      activeMaterial = tokens.slice(1).join(' ').trim()
      if (activeMaterial.length > 0 && materials[activeMaterial] === undefined) {
        materials[activeMaterial] = {}
      }
      continue
    }

    if (activeMaterial.length === 0) {
      continue
    }

    if (type === 'kd') {
      const red = clamp(Number.parseFloat(tokens[1] ?? '1'), 0, 1)
      const green = clamp(Number.parseFloat(tokens[2] ?? '1'), 0, 1)
      const blue = clamp(Number.parseFloat(tokens[3] ?? '1'), 0, 1)
      const material = materials[activeMaterial] ?? {}
      material.diffuseColor = rgbToHex(
        Math.round(red * 255),
        Math.round(green * 255),
        Math.round(blue * 255),
      )
      materials[activeMaterial] = material
      continue
    }

    if (type === 'map_kd') {
      const mapPath = parseMapPath(tokens)
      if (mapPath.length > 0) {
        const material = materials[activeMaterial] ?? {}
        material.diffuseMapPath = mapPath
        materials[activeMaterial] = material
      }
    }
  }

  return materials
}
