import type { Mat4, Vec3 } from './math'
import {
  composeTransformMat4,
  createLookAtMat4,
  dotVec3,
  normalizeVec3,
  transformPoint,
} from './math'
import type { Mesh, SceneObject } from './mesh'
import { computePointLightShadowVisibility } from './shadows'
import type { ObjectShadowVisibility } from './shadows'

export interface RenderScene {
  objects: SceneObject[]
  background: string
  cameraPosition: Vec3
  cameraTarget: Vec3
  cameraUp: Vec3
  lights: Array<{
    position: Vec3
    color: string
    intensity: number
  }>
  shadowQuality: number
  smoothShading: boolean
  smoothingAngleThresholdDegrees: number
  fieldOfView: number
}

interface ProjectedVertex {
  x: number
  y: number
  depth: number
}

function hexToRgb(color: string): [number, number, number] {
  const normalized = color.trim().replace('#', '')

  if (normalized.length === 3) {
    const red = Number.parseInt(normalized[0] + normalized[0], 16)
    const green = Number.parseInt(normalized[1] + normalized[1], 16)
    const blue = Number.parseInt(normalized[2] + normalized[2], 16)
    return [red, green, blue]
  }

  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ]
}

function packRgba(red: number, green: number, blue: number, alpha = 255): number {
  return ((alpha & 255) << 24) | ((blue & 255) << 16) | ((green & 255) << 8) | (red & 255)
}

function mixColor(color: string, shade: number): number {
  const [red, green, blue] = hexToRgb(color)
  const intensity = Math.max(0, Math.min(1, shade))
  return packRgba(
    Math.round(red * intensity),
    Math.round(green * intensity),
    Math.round(blue * intensity),
  )
}

function edgeFunction(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number {
  return (cx - ax) * (by - ay) - (cy - ay) * (bx - ax)
}

function sampleTexturePixel(
  texture: NonNullable<Mesh['textureData']>,
  u: number,
  v: number,
): [number, number, number] {
  const wrappedU = ((u % 1) + 1) % 1
  const wrappedV = ((v % 1) + 1) % 1
  const x = Math.max(0, Math.min(texture.width - 1, Math.floor(wrappedU * texture.width)))
  const y = Math.max(0, Math.min(texture.height - 1, Math.floor((1 - wrappedV) * texture.height)))
  const offset = (y * texture.width + x) * 4
  return [
    texture.data[offset] ?? 255,
    texture.data[offset + 1] ?? 255,
    texture.data[offset + 2] ?? 255,
  ]
}

function projectVertex(
  point: Vec3,
  fieldOfView: number,
  aspectRatio: number,
  width: number,
  height: number,
): ProjectedVertex {
  const inverseZ = -1 / point[2]
  const scale = 1 / Math.tan(fieldOfView * 0.5)
  const projectedX = (point[0] * scale * inverseZ) / aspectRatio
  const projectedY = point[1] * scale * inverseZ

  return {
    x: (projectedX + 1) * 0.5 * width,
    y: (1 - (projectedY + 1) * 0.5) * height,
    depth: -point[2],
  }
}

function computeSmoothedVertexNormals(
  transformedVertices: Vec3[],
  triangles: Array<[number, number, number]>,
  angleThresholdDegrees: number,
): Array<[Vec3, Vec3, Vec3]> {
  const clampedAngle = Math.max(0, Math.min(180, angleThresholdDegrees))
  const cosineThreshold = Math.cos((clampedAngle * Math.PI) / 180)
  const faceNormals: Vec3[] = triangles.map(([indexA, indexB, indexC]) => {
    const worldA = transformedVertices[indexA]
    const worldB = transformedVertices[indexB]
    const worldC = transformedVertices[indexC]
    if (worldA === undefined || worldB === undefined || worldC === undefined) {
      return [0, 0, 1]
    }

    const edgeABWorld = [worldB[0] - worldA[0], worldB[1] - worldA[1], worldB[2] - worldA[2]] as Vec3
    const edgeACWorld = [worldC[0] - worldA[0], worldC[1] - worldA[1], worldC[2] - worldA[2]] as Vec3
    return normalizeVec3([
      edgeABWorld[1] * edgeACWorld[2] - edgeABWorld[2] * edgeACWorld[1],
      edgeABWorld[2] * edgeACWorld[0] - edgeABWorld[0] * edgeACWorld[2],
      edgeABWorld[0] * edgeACWorld[1] - edgeABWorld[1] * edgeACWorld[0],
    ])
  })

  const vertexToFaceIndices: number[][] = transformedVertices.map(() => [])
  triangles.forEach(([indexA, indexB, indexC], triangleIndex) => {
    vertexToFaceIndices[indexA]?.push(triangleIndex)
    vertexToFaceIndices[indexB]?.push(triangleIndex)
    vertexToFaceIndices[indexC]?.push(triangleIndex)
  })

  const smoothTriangleNormals: Array<[Vec3, Vec3, Vec3]> = []

  for (let triangleIndex = 0; triangleIndex < triangles.length; triangleIndex += 1) {
    const [indexA, indexB, indexC] = triangles[triangleIndex]
    const baseNormal = faceNormals[triangleIndex]

    const smoothForVertex = (vertexIndex: number): Vec3 => {
      const adjacentFaces = vertexToFaceIndices[vertexIndex] ?? []
      let sumX = 0
      let sumY = 0
      let sumZ = 0

      for (const adjacentFaceIndex of adjacentFaces) {
        const candidateNormal = faceNormals[adjacentFaceIndex]
        if (dotVec3(baseNormal, candidateNormal) >= cosineThreshold) {
          sumX += candidateNormal[0]
          sumY += candidateNormal[1]
          sumZ += candidateNormal[2]
        }
      }

      return normalizeVec3([sumX, sumY, sumZ])
    }

    smoothTriangleNormals.push([
      smoothForVertex(indexA),
      smoothForVertex(indexB),
      smoothForVertex(indexC),
    ])
  }

  return smoothTriangleNormals
}

export class SoftwareRenderer {
  private readonly context: CanvasRenderingContext2D

  private readonly canvas: HTMLCanvasElement

  private imageData: ImageData | null = null

  private colorBuffer: Uint32Array | null = null

  private depthBuffer: Float32Array | null = null

  private width = 0

  private height = 0

  private devicePixelRatio = 1

  private renderScale = 1

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const context = canvas.getContext('2d', { alpha: false, desynchronized: true })

    if (context === null) {
      throw new Error('Canvas 2D context is not available in this browser.')
    }

    this.context = context
  }

  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number, renderScale: number): void {
    const normalizedScale = Math.max(0.5, Math.min(1.5, renderScale))
    const pixelWidth = Math.max(1, Math.floor(cssWidth * devicePixelRatio * normalizedScale))
    const pixelHeight = Math.max(1, Math.floor(cssHeight * devicePixelRatio * normalizedScale))

    if (
      pixelWidth === this.width &&
      pixelHeight === this.height &&
      this.devicePixelRatio === devicePixelRatio &&
      this.renderScale === normalizedScale
    ) {
      return
    }

    this.devicePixelRatio = devicePixelRatio
    this.renderScale = normalizedScale
    this.width = pixelWidth
    this.height = pixelHeight
    this.canvas.width = pixelWidth
    this.canvas.height = pixelHeight

    this.imageData = this.context.createImageData(pixelWidth, pixelHeight)
    this.colorBuffer = new Uint32Array(this.imageData.data.buffer)
    this.depthBuffer = new Float32Array(pixelWidth * pixelHeight)
  }

  dispose(): void {
    this.imageData = null
    this.colorBuffer = null
    this.depthBuffer = null
  }

  render(scene: RenderScene): void {
    if (this.imageData === null || this.colorBuffer === null || this.depthBuffer === null) {
      return
    }

    const { width, height } = this
    const backgroundColor = mixColor(scene.background, 1)
    this.colorBuffer.fill(backgroundColor)
    this.depthBuffer.fill(Number.POSITIVE_INFINITY)

    const cameraMatrix = createLookAtMat4(scene.cameraPosition, scene.cameraTarget, scene.cameraUp)
    const aspectRatio = width / height
    const diffuseWeight = 0.95
    const shadowVisibilityByObject = computePointLightShadowVisibility(
      scene.objects,
      scene.lights,
      scene.shadowQuality,
      scene.smoothShading,
    )

    for (let objectIndex = 0; objectIndex < scene.objects.length; objectIndex += 1) {
      const object = scene.objects[objectIndex]
      this.drawObject(
        object.mesh,
        object.transform,
        scene.cameraPosition,
        scene.lights,
        shadowVisibilityByObject[objectIndex],
        scene.smoothShading,
        scene.smoothingAngleThresholdDegrees,
        cameraMatrix,
        scene.fieldOfView,
        aspectRatio,
        diffuseWeight,
      )
    }

    this.context.putImageData(this.imageData, 0, 0)
  }

  private drawObject(
    mesh: Mesh,
    transform: SceneObject['transform'],
    cameraPosition: Vec3,
    lights: RenderScene['lights'],
    shadowVisibility: ObjectShadowVisibility,
    smoothShading: boolean,
    smoothingAngleThresholdDegrees: number,
    cameraMatrix: Mat4,
    fieldOfView: number,
    aspectRatio: number,
    diffuseWeight: number,
  ): void {
    if (this.colorBuffer === null || this.depthBuffer === null) {
      return
    }

    const modelMatrix = composeTransformMat4(transform.position, transform.rotation, transform.scale)
    const transformedVertices: Vec3[] = []
    const projectedVertices: ProjectedVertex[] = []

    for (const vertex of mesh.vertices) {
      const worldPoint = transformPoint(modelMatrix, vertex)
      const viewPoint = transformPoint(cameraMatrix, worldPoint)
      transformedVertices.push(worldPoint)
      projectedVertices.push(projectVertex(viewPoint, fieldOfView, aspectRatio, this.width, this.height))
    }

    const smoothNormals = smoothShading
      ? computeSmoothedVertexNormals(
          transformedVertices,
          mesh.triangles,
          smoothingAngleThresholdDegrees,
        )
      : null

    for (let triangleIndex = 0; triangleIndex < mesh.triangles.length; triangleIndex += 1) {
      const [indexA, indexB, indexC] = mesh.triangles[triangleIndex]
      const triangleColor = mesh.triangleColors?.[triangleIndex] ?? mesh.color
      const worldA = transformedVertices[indexA]
      const worldB = transformedVertices[indexB]
      const worldC = transformedVertices[indexC]

      const edgeABWorld = [worldB[0] - worldA[0], worldB[1] - worldA[1], worldB[2] - worldA[2]] as Vec3
      const edgeACWorld = [worldC[0] - worldA[0], worldC[1] - worldA[1], worldC[2] - worldA[2]] as Vec3
      const faceNormalWorld = normalizeVec3([
        edgeABWorld[1] * edgeACWorld[2] - edgeABWorld[2] * edgeACWorld[1],
        edgeABWorld[2] * edgeACWorld[0] - edgeABWorld[0] * edgeACWorld[2],
        edgeABWorld[0] * edgeACWorld[1] - edgeABWorld[1] * edgeACWorld[0],
      ])

      let normalWorld = faceNormalWorld
      if (smoothNormals !== null) {
        const [normalA, normalB, normalC] = smoothNormals[triangleIndex] ?? []
        if (normalA !== undefined && normalB !== undefined && normalC !== undefined) {
          normalWorld = normalizeVec3([
            normalA[0] + normalB[0] + normalC[0],
            normalA[1] + normalB[1] + normalC[1],
            normalA[2] + normalB[2] + normalC[2],
          ])
        }
      }

      const centroid = [
        (worldA[0] + worldB[0] + worldC[0]) / 3,
        (worldA[1] + worldB[1] + worldC[1]) / 3,
        (worldA[2] + worldB[2] + worldC[2]) / 3,
      ] as Vec3
      const toCamera = normalizeVec3([
        cameraPosition[0] - centroid[0],
        cameraPosition[1] - centroid[1],
        cameraPosition[2] - centroid[2],
      ])

      if (!mesh.doubleSided && dotVec3(faceNormalWorld, toCamera) <= 0) {
        continue
      }

      if (mesh.emissive) {
        this.fillTriangle(
          projectedVertices[indexA],
          projectedVertices[indexB],
          projectedVertices[indexC],
          mixColor(triangleColor, 1),
        )
        continue
      }

      let lightMultiplierRed = 0
      let lightMultiplierGreen = 0
      let lightMultiplierBlue = 0

      for (let lightIndex = 0; lightIndex < lights.length; lightIndex += 1) {
        const light = lights[lightIndex]
        const objectLightVector = [
          light.position[0] - centroid[0],
          light.position[1] - centroid[1],
          light.position[2] - centroid[2],
        ] as Vec3
        const objectLightDistanceSquared = Math.max(
          0.001,
          objectLightVector[0] * objectLightVector[0] +
            objectLightVector[1] * objectLightVector[1] +
            objectLightVector[2] * objectLightVector[2],
        )
        const objectLightDirection = normalizeVec3(objectLightVector)
        const attenuation = 1 / (1 + objectLightDistanceSquared * 0.08)
        const lambert = Math.max(0, dotVec3(normalWorld, objectLightDirection))
        const shadow = smoothShading
          ? ((shadowVisibility.perVertex[triangleIndex]?.[0]?.[lightIndex] ?? 1) +
              (shadowVisibility.perVertex[triangleIndex]?.[1]?.[lightIndex] ?? 1) +
              (shadowVisibility.perVertex[triangleIndex]?.[2]?.[lightIndex] ?? 1)) /
            3
          : shadowVisibility.flat[triangleIndex]?.[lightIndex] ?? 1
        const diffuseLighting =
          lambert * diffuseWeight * attenuation * Math.max(0, light.intensity) * shadow
        const [lightRed, lightGreen, lightBlue] = hexToRgb(light.color)
        lightMultiplierRed += (lightRed / 255) * diffuseLighting
        lightMultiplierGreen += (lightGreen / 255) * diffuseLighting
        lightMultiplierBlue += (lightBlue / 255) * diffuseLighting
      }

      const triangleUv = mesh.triangleTextureCoords?.[triangleIndex] ?? null
      const activeTexture = mesh.textureData

      if (triangleUv !== null && activeTexture !== undefined) {
        this.fillTexturedTriangle(
          projectedVertices[indexA],
          projectedVertices[indexB],
          projectedVertices[indexC],
          triangleUv,
          activeTexture,
          lightMultiplierRed,
          lightMultiplierGreen,
          lightMultiplierBlue,
        )
        continue
      }

      const [baseRed, baseGreen, baseBlue] = hexToRgb(triangleColor)
      const red = Math.min(255, baseRed * lightMultiplierRed)
      const green = Math.min(255, baseGreen * lightMultiplierGreen)
      const blue = Math.min(255, baseBlue * lightMultiplierBlue)
      const packedColor = packRgba(Math.round(red), Math.round(green), Math.round(blue))

      this.fillTriangle(
        projectedVertices[indexA],
        projectedVertices[indexB],
        projectedVertices[indexC],
        packedColor,
      )
    }
  }

  private fillTexturedTriangle(
    vertexA: ProjectedVertex,
    vertexB: ProjectedVertex,
    vertexC: ProjectedVertex,
    uv: [[number, number], [number, number], [number, number]],
    texture: NonNullable<Mesh['textureData']>,
    lightRed: number,
    lightGreen: number,
    lightBlue: number,
  ): void {
    if (this.colorBuffer === null || this.depthBuffer === null) {
      return
    }

    const minX = Math.max(0, Math.floor(Math.min(vertexA.x, vertexB.x, vertexC.x)))
    const maxX = Math.min(this.width - 1, Math.ceil(Math.max(vertexA.x, vertexB.x, vertexC.x)))
    const minY = Math.max(0, Math.floor(Math.min(vertexA.y, vertexB.y, vertexC.y)))
    const maxY = Math.min(this.height - 1, Math.ceil(Math.max(vertexA.y, vertexB.y, vertexC.y)))
    const triangleArea = edgeFunction(vertexA.x, vertexA.y, vertexB.x, vertexB.y, vertexC.x, vertexC.y)

    if (triangleArea === 0) {
      return
    }

    const inverseArea = 1 / triangleArea
    const winding = triangleArea > 0 ? 1 : -1

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const sampleX = x + 0.5
        const sampleY = y + 0.5
        const weightA = edgeFunction(vertexB.x, vertexB.y, vertexC.x, vertexC.y, sampleX, sampleY)
        const weightB = edgeFunction(vertexC.x, vertexC.y, vertexA.x, vertexA.y, sampleX, sampleY)
        const weightC = edgeFunction(vertexA.x, vertexA.y, vertexB.x, vertexB.y, sampleX, sampleY)

        if (weightA * winding < 0 || weightB * winding < 0 || weightC * winding < 0) {
          continue
        }

        const normalizedA = weightA * inverseArea
        const normalizedB = weightB * inverseArea
        const normalizedC = weightC * inverseArea
        const depth = vertexA.depth * normalizedA + vertexB.depth * normalizedB + vertexC.depth * normalizedC
        const bufferIndex = y * this.width + x

        if (depth >= this.depthBuffer[bufferIndex]) {
          continue
        }

        const interpolatedU =
          uv[0][0] * normalizedA + uv[1][0] * normalizedB + uv[2][0] * normalizedC
        const interpolatedV =
          uv[0][1] * normalizedA + uv[1][1] * normalizedB + uv[2][1] * normalizedC
        const [baseRed, baseGreen, baseBlue] = sampleTexturePixel(texture, interpolatedU, interpolatedV)
        const shadedRed = Math.min(255, baseRed * lightRed)
        const shadedGreen = Math.min(255, baseGreen * lightGreen)
        const shadedBlue = Math.min(255, baseBlue * lightBlue)

        this.depthBuffer[bufferIndex] = depth
        this.colorBuffer[bufferIndex] = packRgba(
          Math.round(shadedRed),
          Math.round(shadedGreen),
          Math.round(shadedBlue),
        )
      }
    }
  }

  private fillTriangle(
    vertexA: ProjectedVertex,
    vertexB: ProjectedVertex,
    vertexC: ProjectedVertex,
    packedColor: number,
  ): void {
    if (this.colorBuffer === null || this.depthBuffer === null) {
      return
    }

    const minX = Math.max(0, Math.floor(Math.min(vertexA.x, vertexB.x, vertexC.x)))
    const maxX = Math.min(this.width - 1, Math.ceil(Math.max(vertexA.x, vertexB.x, vertexC.x)))
    const minY = Math.max(0, Math.floor(Math.min(vertexA.y, vertexB.y, vertexC.y)))
    const maxY = Math.min(this.height - 1, Math.ceil(Math.max(vertexA.y, vertexB.y, vertexC.y)))

    const triangleArea = edgeFunction(vertexA.x, vertexA.y, vertexB.x, vertexB.y, vertexC.x, vertexC.y)

    if (triangleArea === 0) {
      return
    }

    const inverseArea = 1 / triangleArea
    const winding = triangleArea > 0 ? 1 : -1

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const sampleX = x + 0.5
        const sampleY = y + 0.5
        const weightA = edgeFunction(vertexB.x, vertexB.y, vertexC.x, vertexC.y, sampleX, sampleY)
        const weightB = edgeFunction(vertexC.x, vertexC.y, vertexA.x, vertexA.y, sampleX, sampleY)
        const weightC = edgeFunction(vertexA.x, vertexA.y, vertexB.x, vertexB.y, sampleX, sampleY)

        if (weightA * winding < 0 || weightB * winding < 0 || weightC * winding < 0) {
          continue
        }

        const normalizedA = weightA * inverseArea
        const normalizedB = weightB * inverseArea
        const normalizedC = weightC * inverseArea
        const depth = vertexA.depth * normalizedA + vertexB.depth * normalizedB + vertexC.depth * normalizedC
        const bufferIndex = y * this.width + x

        if (depth < this.depthBuffer[bufferIndex]) {
          this.depthBuffer[bufferIndex] = depth
          this.colorBuffer[bufferIndex] = packedColor
        }
      }
    }
  }
}
