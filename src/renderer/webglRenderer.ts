import type { Vec3 } from './math'
import {
  composeTransformMat4,
  createLookAtMat4,
  dotVec3,
  normalizeVec3,
  subVec3,
  transformPoint,
} from './math'
import { hexToRgb } from './color'
import type { Mesh, SceneObject } from './mesh'
import { computePointLightShadowVisibility } from './shadows'
import type { ObjectShadowVisibility } from './shadows'
import { buildShadowCacheKey, buildVertexCacheKey } from './renderCache'

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

function computeTriangleSmoothNormals(
  transformedVertices: Vec3[],
  triangles: Array<[number, number, number]>,
  angleThresholdDegrees: number,
): Array<[Vec3, Vec3, Vec3]> {
  const clampedAngle = Math.max(0, Math.min(180, angleThresholdDegrees))
  const cosineThreshold = Math.cos((clampedAngle * Math.PI) / 180)
  const faceNormals: Vec3[] = triangles.map(([indexA, indexB, indexC]) => {
    const vertexA = transformedVertices[indexA]
    const vertexB = transformedVertices[indexB]
    const vertexC = transformedVertices[indexC]
    if (vertexA === undefined || vertexB === undefined || vertexC === undefined) {
      return [0, 0, 1]
    }

    const edgeAB = subVec3(vertexB, vertexA)
    const edgeAC = subVec3(vertexC, vertexA)
    return normalizeVec3([
      edgeAB[1] * edgeAC[2] - edgeAB[2] * edgeAC[1],
      edgeAB[2] * edgeAC[0] - edgeAB[0] * edgeAC[2],
      edgeAB[0] * edgeAC[1] - edgeAB[1] * edgeAC[0],
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
        if (
          candidateNormal !== undefined &&
          baseNormal !== undefined &&
          dotVec3(baseNormal, candidateNormal) >= cosineThreshold
        ) {
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

interface DrawVertex {
  position: Vec3
  normal: Vec3
  color: [number, number, number]
  uv: [number, number]
  useTexture: number
  emissive: number
  objectCenter: Vec3
  twoSided: number
  shadowMask: [number, number, number, number]
}

const MAX_POINT_LIGHTS = 4

function createShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (shader === null) {
    throw new Error('Unable to create shader.')
  }

  gl.shaderSource(shader, source)
  gl.compileShader(shader)

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? 'Unknown shader error.'
    gl.deleteShader(shader)
    throw new Error(message)
  }

  return shader
}

function createProgram(gl: WebGLRenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram {
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexSource)
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource)
  const program = gl.createProgram()

  if (program === null) {
    gl.deleteShader(vertexShader)
    gl.deleteShader(fragmentShader)
    throw new Error('Unable to create WebGL program.')
  }

  gl.attachShader(program, vertexShader)
  gl.attachShader(program, fragmentShader)
  gl.linkProgram(program)
  gl.deleteShader(vertexShader)
  gl.deleteShader(fragmentShader)

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) ?? 'Unknown program error.'
    gl.deleteProgram(program)
    throw new Error(message)
  }

  return program
}

function createPerspectiveMat4(fieldOfView: number, aspectRatio: number, near: number, far: number): Float32Array {
  const matrix = new Float32Array(16)
  const f = 1 / Math.tan(fieldOfView / 2)
  const rangeInv = 1 / (near - far)

  matrix[0] = f / aspectRatio
  matrix[5] = f
  matrix[10] = (far + near) * rangeInv
  matrix[11] = -1
  matrix[14] = 2 * far * near * rangeInv
  return matrix
}

function buildFaceVertices(
  mesh: Mesh,
  transform: SceneObject['transform'],
  shadowVisibility: ObjectShadowVisibility,
  smoothShading: boolean,
  smoothingAngleThresholdDegrees: number,
): DrawVertex[] {
  const modelMatrix = composeTransformMat4(transform.position, transform.rotation, transform.scale)
  const transformedVertices = mesh.vertices.map((vertex) => transformPoint(modelMatrix, vertex))
  const smoothedNormals: Array<[Vec3, Vec3, Vec3]> | null = smoothShading
    ? computeTriangleSmoothNormals(
        transformedVertices,
        mesh.triangles,
        smoothingAngleThresholdDegrees,
      )
    : null

  const result: DrawVertex[] = []

  for (let triangleIndex = 0; triangleIndex < mesh.triangles.length; triangleIndex += 1) {
    const [indexA, indexB, indexC] = mesh.triangles[triangleIndex]
    const vertexA = transformedVertices[indexA]
    const vertexB = transformedVertices[indexB]
    const vertexC = transformedVertices[indexC]
    if (vertexA === undefined || vertexB === undefined || vertexC === undefined) {
      continue
    }
    const edgeAB = subVec3(vertexB, vertexA)
    const edgeAC = subVec3(vertexC, vertexA)
    const faceNormal = normalizeVec3([
      edgeAB[1] * edgeAC[2] - edgeAB[2] * edgeAC[1],
      edgeAB[2] * edgeAC[0] - edgeAB[0] * edgeAC[2],
      edgeAB[0] * edgeAC[1] - edgeAB[1] * edgeAC[0],
    ])
    const [smoothNormalA, smoothNormalB, smoothNormalC] = smoothedNormals?.[triangleIndex] ?? []
    const normalA = smoothNormalA ?? faceNormal
    const normalB = smoothNormalB ?? faceNormal
    const normalC = smoothNormalC ?? faceNormal
    const objectCenter: Vec3 = [transform.position[0], transform.position[1], transform.position[2]]
    const triangleColor = mesh.triangleColors?.[triangleIndex] ?? mesh.color
    const color = hexToRgb(triangleColor)
    const triangleUv = mesh.triangleTextureCoords?.[triangleIndex] ?? null
    const useTexture = triangleUv !== null && mesh.textureData !== undefined ? 1 : 0
    const uvA: [number, number] = triangleUv?.[0] ?? [0, 0]
    const uvB: [number, number] = triangleUv?.[1] ?? [0, 0]
    const uvC: [number, number] = triangleUv?.[2] ?? [0, 0]
    const emissive = mesh.emissive ? 1 : 0
    const twoSided = mesh.doubleSided ? 1 : 0
    const triangleVisibility = shadowVisibility.flat[triangleIndex] ?? [1, 1, 1, 1]
    const vertexVisibility = shadowVisibility.perVertex[triangleIndex]
    const shadowMaskA: [number, number, number, number] = smoothShading
      ? [
          vertexVisibility?.[0]?.[0] ?? triangleVisibility[0] ?? 1,
          vertexVisibility?.[0]?.[1] ?? triangleVisibility[1] ?? 1,
          vertexVisibility?.[0]?.[2] ?? triangleVisibility[2] ?? 1,
          vertexVisibility?.[0]?.[3] ?? triangleVisibility[3] ?? 1,
        ]
      : [
          triangleVisibility[0] ?? 1,
          triangleVisibility[1] ?? 1,
          triangleVisibility[2] ?? 1,
          triangleVisibility[3] ?? 1,
        ]
    const shadowMaskB: [number, number, number, number] = smoothShading
      ? [
          vertexVisibility?.[1]?.[0] ?? triangleVisibility[0] ?? 1,
          vertexVisibility?.[1]?.[1] ?? triangleVisibility[1] ?? 1,
          vertexVisibility?.[1]?.[2] ?? triangleVisibility[2] ?? 1,
          vertexVisibility?.[1]?.[3] ?? triangleVisibility[3] ?? 1,
        ]
      : shadowMaskA
    const shadowMaskC: [number, number, number, number] = smoothShading
      ? [
          vertexVisibility?.[2]?.[0] ?? triangleVisibility[0] ?? 1,
          vertexVisibility?.[2]?.[1] ?? triangleVisibility[1] ?? 1,
          vertexVisibility?.[2]?.[2] ?? triangleVisibility[2] ?? 1,
          vertexVisibility?.[2]?.[3] ?? triangleVisibility[3] ?? 1,
        ]
      : shadowMaskA

    result.push(
      {
        position: vertexA,
        normal: normalA,
        color,
        uv: uvA,
        useTexture,
        emissive,
        objectCenter,
        twoSided,
        shadowMask: shadowMaskA,
      },
      {
        position: vertexB,
        normal: normalB,
        color,
        uv: uvB,
        useTexture,
        emissive,
        objectCenter,
        twoSided,
        shadowMask: shadowMaskB,
      },
      {
        position: vertexC,
        normal: normalC,
        color,
        uv: uvC,
        useTexture,
        emissive,
        objectCenter,
        twoSided,
        shadowMask: shadowMaskC,
      },
    )
  }

  return result
}

export class WebGLRenderer {
  private readonly gl: WebGLRenderingContext

  private readonly canvas: HTMLCanvasElement

  private readonly program: WebGLProgram

  private readonly positionBuffer: WebGLBuffer

  private readonly normalBuffer: WebGLBuffer

  private readonly colorBuffer: WebGLBuffer

  private readonly uvBuffer: WebGLBuffer

  private readonly useTextureBuffer: WebGLBuffer

  private readonly emissiveBuffer: WebGLBuffer

  private readonly objectCenterBuffer: WebGLBuffer

  private readonly twoSidedBuffer: WebGLBuffer

  private readonly shadowMaskBuffer: WebGLBuffer

  private readonly positionLocation: number

  private readonly normalLocation: number

  private readonly colorLocation: number

  private readonly uvLocation: number

  private readonly useTextureLocation: number

  private readonly emissiveLocation: number

  private readonly objectCenterLocation: number

  private readonly twoSidedLocation: number

  private readonly shadowMaskLocation: number

  private readonly uViewLocation: WebGLUniformLocation

  private readonly uProjectionLocation: WebGLUniformLocation

  private readonly uLightCountLocation: WebGLUniformLocation

  private readonly uLightPositionsLocation: WebGLUniformLocation

  private readonly uLightColorsLocation: WebGLUniformLocation

  private readonly uLightIntensitiesLocation: WebGLUniformLocation

  private readonly uAmbientLocation: WebGLUniformLocation

  private readonly uDiffuseLocation: WebGLUniformLocation

  private readonly uDiffuseTextureLocation: WebGLUniformLocation

  private readonly diffuseTexture: WebGLTexture

  private lastTextureData: Mesh['textureData'] | undefined

  private currentWidth = 0

  private currentHeight = 0

  private currentScale = 1

  // --- Shadow visibility cache ---
  private cachedShadowKey = ''

  private cachedShadowVisibility: ObjectShadowVisibility[] | null = null

  // --- Vertex data cache ---
  private cachedVertexKey = ''

  private cachedVertexCount = 0

  // --- Reusable uniform arrays (fixed size, never need to grow) ---
  private lightPositionsArray = new Float32Array(MAX_POINT_LIGHTS * 3)

  private lightColorsArray = new Float32Array(MAX_POINT_LIGHTS * 3)

  private lightIntensitiesArray = new Float32Array(MAX_POINT_LIGHTS)

  // --- Reusable vertex attribute arrays (grow as needed) ---
  private positionsArray: Float32Array<ArrayBufferLike> = new Float32Array(0)

  private normalsArray: Float32Array<ArrayBufferLike> = new Float32Array(0)

  private colorsArray: Float32Array<ArrayBufferLike> = new Float32Array(0)

  private uvArray: Float32Array<ArrayBufferLike> = new Float32Array(0)

  private useTextureArray: Float32Array<ArrayBufferLike> = new Float32Array(0)

  private emissiveArray: Float32Array<ArrayBufferLike> = new Float32Array(0)

  private objectCentersArray: Float32Array<ArrayBufferLike> = new Float32Array(0)

  private twoSidedArray: Float32Array<ArrayBufferLike> = new Float32Array(0)

  private shadowMasksArray: Float32Array<ArrayBufferLike> = new Float32Array(0)

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const context = canvas.getContext('webgl', {
      alpha: false,
      antialias: true,
      depth: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    })

    if (context === null) {
      throw new Error('WebGL is not available in this browser.')
    }

    this.gl = context
    const vertexSource = `
      precision highp float;

      attribute vec3 aPosition;
      attribute vec3 aNormal;
      attribute vec3 aColor;
      attribute vec2 aUv;
      attribute float aUseTexture;
      attribute float aEmissive;
      attribute vec3 aObjectCenter;
      attribute float aTwoSided;
      attribute vec4 aShadowMask;

      uniform mat4 uView;
      uniform mat4 uProjection;
      uniform int uLightCount;
      uniform vec3 uLightPositions[4];
      uniform vec3 uLightColors[4];
      uniform float uLightIntensities[4];

      varying vec3 vNormal;
      varying vec3 vColor;
      varying vec2 vUv;
      varying float vUseTexture;
      varying float vEmissive;
      varying vec3 vObjectCenter;
      varying float vTwoSided;
      varying vec3 vWorldPosition;
      varying vec4 vShadowMask;

      void main() {
        vNormal = aNormal;
        vColor = aColor;
        vUv = aUv;
        vUseTexture = aUseTexture;
        vEmissive = aEmissive;
        vObjectCenter = aObjectCenter;
        vTwoSided = aTwoSided;
        vWorldPosition = aPosition;
        vShadowMask = aShadowMask;
        gl_Position = uProjection * uView * vec4(aPosition, 1.0);
      }
    `

    const fragmentSource = `
      precision highp float;

      varying vec3 vNormal;
      varying vec3 vColor;
      varying vec2 vUv;
      varying float vUseTexture;
      varying float vEmissive;
      varying vec3 vObjectCenter;
      varying float vTwoSided;
      varying vec3 vWorldPosition;
      varying vec4 vShadowMask;

      uniform int uLightCount;
      uniform vec3 uLightPositions[4];
      uniform vec3 uLightColors[4];
      uniform float uLightIntensities[4];
      uniform float uAmbient;
      uniform float uDiffuse;
      uniform sampler2D uDiffuseTexture;

      void main() {
        vec3 baseColor = vColor;
        if (vUseTexture > 0.5) {
          baseColor = texture2D(uDiffuseTexture, vec2(vUv.x, 1.0 - vUv.y)).rgb;
        }

        if (vEmissive > 0.5) {
          gl_FragColor = vec4(baseColor, 1.0);
          return;
        }

        vec3 ambientColor = baseColor * uAmbient;
        vec3 diffuseColor = vec3(0.0);

        for (int index = 0; index < 4; index += 1) {
          if (index >= uLightCount) {
            break;
          }

          vec3 lightVector = uLightPositions[index] - vWorldPosition;
          float distanceSquared = max(0.001, dot(lightVector, lightVector));
          vec3 lightDirection = normalize(lightVector);
          float attenuation = 1.0 / (1.0 + distanceSquared * 0.08);
          float normalLightDot = dot(vNormal, lightDirection);
          float diffuse = max(normalLightDot, 0.0);
          float shadow = 1.0;
          if (index == 0) {
            shadow = vShadowMask.x;
          } else if (index == 1) {
            shadow = vShadowMask.y;
          } else if (index == 2) {
            shadow = vShadowMask.z;
          } else {
            shadow = vShadowMask.w;
          }
          float litStrength = diffuse * uDiffuse * attenuation * uLightIntensities[index] * shadow;
          diffuseColor += baseColor * uLightColors[index] * litStrength;
        }

        gl_FragColor = vec4(ambientColor + diffuseColor, 1.0);
      }
    `

    this.program = createProgram(this.gl, vertexSource, fragmentSource)
    this.positionBuffer = this.createBuffer()
    this.normalBuffer = this.createBuffer()
    this.colorBuffer = this.createBuffer()
    this.uvBuffer = this.createBuffer()
    this.useTextureBuffer = this.createBuffer()
    this.emissiveBuffer = this.createBuffer()
    this.objectCenterBuffer = this.createBuffer()
    this.twoSidedBuffer = this.createBuffer()
    this.shadowMaskBuffer = this.createBuffer()

    this.positionLocation = this.requireAttrib('aPosition')
    this.normalLocation = this.requireAttrib('aNormal')
    this.colorLocation = this.requireAttrib('aColor')
    this.uvLocation = this.requireAttrib('aUv')
    this.useTextureLocation = this.requireAttrib('aUseTexture')
    this.emissiveLocation = this.requireAttrib('aEmissive')
    this.objectCenterLocation = this.requireAttrib('aObjectCenter')
    this.twoSidedLocation = this.requireAttrib('aTwoSided')
    this.shadowMaskLocation = this.requireAttrib('aShadowMask')

    this.uViewLocation = this.requireUniform('uView')
    this.uProjectionLocation = this.requireUniform('uProjection')
    this.uLightCountLocation = this.requireUniform('uLightCount')
    this.uLightPositionsLocation = this.requireUniform('uLightPositions')
    this.uLightColorsLocation = this.requireUniform('uLightColors')
    this.uLightIntensitiesLocation = this.requireUniform('uLightIntensities')
    this.uAmbientLocation = this.requireUniform('uAmbient')
    this.uDiffuseLocation = this.requireUniform('uDiffuse')
    this.uDiffuseTextureLocation = this.requireUniform('uDiffuseTexture')

    const texture = this.gl.createTexture()
    if (texture === null) {
      throw new Error('Unable to create WebGL texture.')
    }
    this.diffuseTexture = texture
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.diffuseTexture)
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR)
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR)
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.REPEAT)
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.REPEAT)
    this.gl.texImage2D(
      this.gl.TEXTURE_2D,
      0,
      this.gl.RGBA,
      1,
      1,
      0,
      this.gl.RGBA,
      this.gl.UNSIGNED_BYTE,
      new Uint8Array([255, 255, 255, 255]),
    )
  }

  private createBuffer(): WebGLBuffer {
    const buffer = this.gl.createBuffer()
    if (buffer === null) {
      throw new Error('Unable to create WebGL buffer.')
    }
    return buffer
  }

  private requireAttrib(name: string): number {
    const location = this.gl.getAttribLocation(this.program, name)
    if (location < 0) {
      throw new Error(`Missing attribute: ${name}`)
    }
    return location
  }

  private requireUniform(name: string): WebGLUniformLocation {
    const location = this.gl.getUniformLocation(this.program, name)
    if (location === null) {
      throw new Error(`Missing uniform: ${name}`)
    }
    return location
  }

  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number, renderScale: number): boolean {
    const normalizedScale = Math.max(0.5, Math.min(1.5, renderScale))
    const pixelWidth = Math.max(1, Math.floor(cssWidth * devicePixelRatio * normalizedScale))
    const pixelHeight = Math.max(1, Math.floor(cssHeight * devicePixelRatio * normalizedScale))

    if (
      pixelWidth === this.currentWidth &&
      pixelHeight === this.currentHeight &&
      normalizedScale === this.currentScale
    ) {
      return false
    }

    this.currentScale = normalizedScale
    this.currentWidth = pixelWidth
    this.currentHeight = pixelHeight
    this.canvas.width = pixelWidth
    this.canvas.height = pixelHeight
    this.gl.viewport(0, 0, pixelWidth, pixelHeight)
    return true
  }

  dispose(): void {
    this.cachedShadowKey = ''
    this.cachedShadowVisibility = null
    this.cachedVertexKey = ''
    this.cachedVertexCount = 0

    const { gl } = this
    gl.deleteBuffer(this.positionBuffer)
    gl.deleteBuffer(this.normalBuffer)
    gl.deleteBuffer(this.colorBuffer)
    gl.deleteBuffer(this.uvBuffer)
    gl.deleteBuffer(this.useTextureBuffer)
    gl.deleteBuffer(this.emissiveBuffer)
    gl.deleteBuffer(this.objectCenterBuffer)
    gl.deleteBuffer(this.twoSidedBuffer)
    gl.deleteBuffer(this.shadowMaskBuffer)
    gl.deleteTexture(this.diffuseTexture)
    gl.deleteProgram(this.program)
  }

  render(scene: RenderScene): void {
    const { gl } = this
    gl.useProgram(this.program)

    const viewMatrix = createLookAtMat4(scene.cameraPosition, scene.cameraTarget, scene.cameraUp)
    const aspectRatio = this.currentWidth / this.currentHeight
    const projectionMatrix = createPerspectiveMat4(scene.fieldOfView, aspectRatio, 0.1, 100)
    const background = hexToRgb(scene.background).map((value) => value / 255) as [number, number, number]

    gl.uniformMatrix4fv(this.uViewLocation, false, viewMatrix)
    gl.uniformMatrix4fv(this.uProjectionLocation, false, projectionMatrix)
    const lightCount = Math.min(MAX_POINT_LIGHTS, scene.lights.length)
    this.lightPositionsArray.fill(0)
    this.lightColorsArray.fill(0)
    this.lightIntensitiesArray.fill(0)

    for (let index = 0; index < lightCount; index += 1) {
      const light = scene.lights[index]
      this.lightPositionsArray[index * 3 + 0] = light.position[0]
      this.lightPositionsArray[index * 3 + 1] = light.position[1]
      this.lightPositionsArray[index * 3 + 2] = light.position[2]
      const [red, green, blue] = hexToRgb(light.color).map((value) => value / 255) as [number, number, number]
      this.lightColorsArray[index * 3 + 0] = red
      this.lightColorsArray[index * 3 + 1] = green
      this.lightColorsArray[index * 3 + 2] = blue
      this.lightIntensitiesArray[index] = Math.max(0, light.intensity)
    }

    gl.uniform1i(this.uLightCountLocation, lightCount)
    gl.uniform3fv(this.uLightPositionsLocation, this.lightPositionsArray)
    gl.uniform3fv(this.uLightColorsLocation, this.lightColorsArray)
    gl.uniform1fv(this.uLightIntensitiesLocation, this.lightIntensitiesArray)
    gl.uniform1f(this.uAmbientLocation, 0)
    gl.uniform1f(this.uDiffuseLocation, 0.95)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.diffuseTexture)
    gl.uniform1i(this.uDiffuseTextureLocation, 0)

    gl.enable(gl.DEPTH_TEST)
    gl.clearColor(background[0], background[1], background[2], 1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

    // --- Shadow visibility cache ---
    // Skip the expensive shadow computation when lights, objects, and
    // quality settings haven't changed since the previous frame.
    const shadowKey = buildShadowCacheKey(scene.objects, scene.lights, scene.shadowQuality, scene.smoothShading)
    let shadowVisibilityByObject = this.cachedShadowVisibility
    if (shadowKey !== this.cachedShadowKey || shadowVisibilityByObject === null) {
      shadowVisibilityByObject = computePointLightShadowVisibility(
        scene.objects,
        scene.lights,
        scene.shadowQuality,
        scene.smoothShading,
      )
      this.cachedShadowKey = shadowKey
      this.cachedShadowVisibility = shadowVisibilityByObject
    }

    // --- Vertex data cache ---
    // Skip vertex rebuilding, buffer allocation, and GPU uploads when
    // the mesh, transform, shadows, and shading settings are unchanged.
    const vertexKey = buildVertexCacheKey(
      scene.objects,
      scene.lights,
      scene.shadowQuality,
      scene.smoothShading,
      scene.smoothingAngleThresholdDegrees,
    )

    if (vertexKey !== this.cachedVertexKey) {
      const vertices: DrawVertex[] = []
      let activeTextureData: Mesh['textureData'] | undefined
      for (let objectIndex = 0; objectIndex < scene.objects.length; objectIndex += 1) {
        const object = scene.objects[objectIndex]
        if (activeTextureData === undefined && object.mesh.textureData !== undefined) {
          activeTextureData = object.mesh.textureData
        }
        const objectVertices = buildFaceVertices(
          object.mesh,
          object.transform,
          shadowVisibilityByObject[objectIndex],
          scene.smoothShading,
          scene.smoothingAngleThresholdDegrees,
        )
        for (const vertex of objectVertices) {
          vertices.push(vertex)
        }
      }

      this.uploadDiffuseTexture(activeTextureData)
      this.cachedVertexCount = vertices.length

      const vCount = vertices.length
      this.positionsArray = this.ensureArrayCapacity(this.positionsArray, vCount * 3)
      this.normalsArray = this.ensureArrayCapacity(this.normalsArray, vCount * 3)
      this.colorsArray = this.ensureArrayCapacity(this.colorsArray, vCount * 3)
      this.uvArray = this.ensureArrayCapacity(this.uvArray, vCount * 2)
      this.useTextureArray = this.ensureArrayCapacity(this.useTextureArray, vCount)
      this.emissiveArray = this.ensureArrayCapacity(this.emissiveArray, vCount)
      this.objectCentersArray = this.ensureArrayCapacity(this.objectCentersArray, vCount * 3)
      this.twoSidedArray = this.ensureArrayCapacity(this.twoSidedArray, vCount)
      this.shadowMasksArray = this.ensureArrayCapacity(this.shadowMasksArray, vCount * 4)

      for (let index = 0; index < vCount; index += 1) {
        const vertex = vertices[index]
        this.positionsArray[index * 3 + 0] = vertex.position[0]
        this.positionsArray[index * 3 + 1] = vertex.position[1]
        this.positionsArray[index * 3 + 2] = vertex.position[2]
        this.normalsArray[index * 3 + 0] = vertex.normal[0]
        this.normalsArray[index * 3 + 1] = vertex.normal[1]
        this.normalsArray[index * 3 + 2] = vertex.normal[2]
        this.colorsArray[index * 3 + 0] = vertex.color[0] / 255
        this.colorsArray[index * 3 + 1] = vertex.color[1] / 255
        this.colorsArray[index * 3 + 2] = vertex.color[2] / 255
        this.uvArray[index * 2 + 0] = vertex.uv[0]
        this.uvArray[index * 2 + 1] = vertex.uv[1]
        this.useTextureArray[index] = vertex.useTexture
        this.emissiveArray[index] = vertex.emissive
        this.objectCentersArray[index * 3 + 0] = vertex.objectCenter[0]
        this.objectCentersArray[index * 3 + 1] = vertex.objectCenter[1]
        this.objectCentersArray[index * 3 + 2] = vertex.objectCenter[2]
        this.twoSidedArray[index] = vertex.twoSided
        this.shadowMasksArray[index * 4 + 0] = vertex.shadowMask[0]
        this.shadowMasksArray[index * 4 + 1] = vertex.shadowMask[1]
        this.shadowMasksArray[index * 4 + 2] = vertex.shadowMask[2]
        this.shadowMasksArray[index * 4 + 3] = vertex.shadowMask[3]
      }

      this.uploadArray(this.positionBuffer, this.positionsArray.subarray(0, vCount * 3))
      this.uploadArray(this.normalBuffer, this.normalsArray.subarray(0, vCount * 3))
      this.uploadArray(this.colorBuffer, this.colorsArray.subarray(0, vCount * 3))
      this.uploadArray(this.uvBuffer, this.uvArray.subarray(0, vCount * 2))
      this.uploadArray(this.useTextureBuffer, this.useTextureArray.subarray(0, vCount))
      this.uploadArray(this.emissiveBuffer, this.emissiveArray.subarray(0, vCount))
      this.uploadArray(this.objectCenterBuffer, this.objectCentersArray.subarray(0, vCount * 3))
      this.uploadArray(this.twoSidedBuffer, this.twoSidedArray.subarray(0, vCount))
      this.uploadArray(this.shadowMaskBuffer, this.shadowMasksArray.subarray(0, vCount * 4))

      this.bindAttribute(this.positionBuffer, this.positionLocation, 3)
      this.bindAttribute(this.normalBuffer, this.normalLocation, 3)
      this.bindAttribute(this.colorBuffer, this.colorLocation, 3)
      this.bindAttribute(this.uvBuffer, this.uvLocation, 2)
      this.bindAttribute(this.useTextureBuffer, this.useTextureLocation, 1)
      this.bindAttribute(this.emissiveBuffer, this.emissiveLocation, 1)
      this.bindAttribute(this.objectCenterBuffer, this.objectCenterLocation, 3)
      this.bindAttribute(this.twoSidedBuffer, this.twoSidedLocation, 1)
      this.bindAttribute(this.shadowMaskBuffer, this.shadowMaskLocation, 4)

      this.cachedVertexKey = vertexKey
    }

    gl.drawArrays(gl.TRIANGLES, 0, this.cachedVertexCount)
  }

  private ensureArrayCapacity(buffer: Float32Array, requiredSize: number) {
    if (buffer.length >= requiredSize) {
      return buffer
    }
    return new Float32Array(Math.max(requiredSize, buffer.length * 2, 1024))
  }

  private uploadArray(buffer: WebGLBuffer, data: ArrayBufferView): void {
    const { gl } = this
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW)
  }

  private bindAttribute(buffer: WebGLBuffer, location: number, size: number): void {
    const { gl } = this
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.enableVertexAttribArray(location)
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0)
  }

  private uploadDiffuseTexture(textureData: Mesh['textureData']): void {
    const { gl } = this
    if (textureData === this.lastTextureData) {
      return
    }

    gl.bindTexture(gl.TEXTURE_2D, this.diffuseTexture)
    if (textureData === undefined) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        1,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array([255, 255, 255, 255]),
      )
    } else {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        textureData.width,
        textureData.height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        textureData.data,
      )
    }

    this.lastTextureData = textureData
  }
}

export default WebGLRenderer