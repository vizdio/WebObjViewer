import { useEffect, useRef, useState, type CSSProperties } from 'react'
import './App.css'
import type { Mesh } from './renderer/mesh'
import {
  parseMtlMaterials,
  normalizeResourceName,
  parseObjMaterialLibraries,
  parseObjMesh,
  type ParsedMtlMaterial,
  type TextureData,
} from './renderer/obj'
import { SceneController } from './renderer/scene'
import { SoftwareRenderer } from './renderer/softwareRenderer'
import WebGLRenderer from './renderer/webglRenderer'
import { OBJECT_GENERATORS, type ObjectGeneratorId } from './renderer/generators'
import dodecahedronObj from './objects/dodecahedron.obj?raw'

type RendererMode = 'auto' | 'software' | 'gpu'

type PointLightSettings = {
  id: string
  x: number
  y: number
  z: number
  brightness: number
  color: string
  showMarker: boolean
}

type ObjectSettings = {
  positionX: number
  positionY: number
  positionZ: number
  rotationX: number
  rotationY: number
  rotationZ: number
  scale: number
  showLightMarker: boolean
}

const INITIAL_LIGHT_SETTINGS: PointLightSettings = {
  id: 'light-1',
  x: -3.7,
  y: 0.25,
  z: 4.8,
  brightness: 1.2,
  color: '#ffffff',
  showMarker: true,
}

const INITIAL_EXTRA_LIGHTS: PointLightSettings[] = [
  {
    id: 'light-2',
    x: 4.9,
    y: 0.25,
    z: 1,
    brightness: 1.2,
    color: '#1100ff',
    showMarker: true,
  },
]

const MAX_POINT_LIGHTS = 4

const INITIAL_OBJECT_SETTINGS: ObjectSettings = {
  positionX: 0,
  positionY: 0,
  positionZ: 0,
  rotationX: 8.6,
  rotationY: 20,
  rotationZ: 0,
  scale: 0.92,
  showLightMarker: false,
}

const CAMERA_Z = 7
const MAX_LIGHT_Z = CAMERA_Z - 0.1
const MIN_RENDER_QUALITY = 0.5
const MAX_RENDER_QUALITY = 2
const MIN_SHADOW_QUALITY = 0
const MAX_SHADOW_QUALITY = 2
const MIN_SMOOTHING_ANGLE = 0
const MAX_SMOOTHING_ANGLE = 180
const MIN_SHEEN = 0
const MAX_SHEEN = 1
const MIN_BUMP_INTENSITY = 0
const MAX_BUMP_INTENSITY = 1

function isTextureFile(fileName: string): boolean {
  const normalized = fileName.toLowerCase()
  return (
    normalized.endsWith('.jpg') ||
    normalized.endsWith('.jpeg') ||
    normalized.endsWith('.png') ||
    normalized.endsWith('.webp') ||
    normalized.endsWith('.bmp') ||
    normalized.endsWith('.gif')
  )
}

async function loadTextureData(file: File): Promise<TextureData> {
  const objectUrl = URL.createObjectURL(file)

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error(`Failed to decode texture: ${file.name}`))
      element.src = objectUrl
    })

    const width = Math.max(1, image.naturalWidth || image.width)
    const height = Math.max(1, image.naturalHeight || image.height)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context === null) {
      throw new Error(`Unable to decode texture pixels for ${file.name}.`)
    }

    context.drawImage(image, 0, 0, width, height)
    const imageData = context.getImageData(0, 0, width, height)
    return {
      width,
      height,
      data: imageData.data,
    }
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

function normalizeMeshForViewport(mesh: Mesh): Mesh {
  if (mesh.vertices.length === 0) {
    return mesh
  }

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY

  for (const [x, y, z] of mesh.vertices) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    minZ = Math.min(minZ, z)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
    maxZ = Math.max(maxZ, z)
  }

  const centerX = (minX + maxX) * 0.5
  const centerY = (minY + maxY) * 0.5
  const centerZ = (minZ + maxZ) * 0.5
  const extentX = maxX - minX
  const extentY = maxY - minY
  const extentZ = maxZ - minZ
  const maxExtent = Math.max(extentX, extentY, extentZ, 0.000001)
  const targetExtent = 2.2
  const scale = targetExtent / maxExtent

  return {
    ...mesh,
    vertices: mesh.vertices.map(([x, y, z]) => [
      (x - centerX) * scale,
      (y - centerY) * scale,
      (z - centerZ) * scale,
    ]),
  }
}

type RendererBackend = {
  resize: (width: number, height: number, devicePixelRatio: number, renderScale: number) => boolean
  render: (scene: any) => void
  dispose: () => void
}

const MIN_PANEL_WIDTH = 200
const MAX_PANEL_WIDTH = 600
const DEFAULT_PANEL_WIDTH = 300

function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rendererRef = useRef<RendererBackend | null>(null)
  const isResizingRef = useRef(false)
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH)
  const sceneRef = useRef(new SceneController(parseObjMesh(dodecahedronObj, 'Dodecahedron', '#ffffff')))
  const primaryLightRef = useRef(INITIAL_LIGHT_SETTINGS)
  const extraLightsRef = useRef<PointLightSettings[]>(INITIAL_EXTRA_LIGHTS)
  const objectSettingsRef = useRef(INITIAL_OBJECT_SETTINGS)
  const objectColorRef = useRef('#ffffff')
  const renderQualityRef = useRef(1)
  const [status, setStatus] = useState('Renderer ready')
  const [modelName, setModelName] = useState('Dodecahedron')
  const [demoMode, setDemoMode] = useState(false)
  const [primaryLight, setPrimaryLight] = useState(INITIAL_LIGHT_SETTINGS)
  const [extraLights, setExtraLights] = useState<PointLightSettings[]>(INITIAL_EXTRA_LIGHTS)
  const [objectSettings, setObjectSettings] = useState(INITIAL_OBJECT_SETTINGS)
  const [objectColor, setObjectColor] = useState('#ffffff')
  const [renderQuality, setRenderQuality] = useState(1)
  const [shadowQuality, setShadowQuality] = useState(1)
  const [shadowsEnabled, setShadowsEnabled] = useState(true)
  const [smoothingEnabled, setSmoothingEnabled] = useState(true)
  const [smoothingAngleThreshold, setSmoothingAngleThreshold] = useState(50)
  const [sheen, setSheen] = useState(0.5)
  const [bumpIntensity, setBumpIntensity] = useState(0.5)
  const [hasBumpMap, setHasBumpMap] = useState(false)
  const [rendererMode, setRendererMode] = useState<RendererMode>('auto')
  const [selectedGenerator, setSelectedGenerator] = useState<ObjectGeneratorId>('sphere')
  const [qualitySectionCollapsed, setQualitySectionCollapsed] = useState(true)
  const [lightingSectionCollapsed, setLightingSectionCollapsed] = useState(true)
  const [transformSectionCollapsed, setTransformSectionCollapsed] = useState(true)
  const shadowQualityRef = useRef(1)
  const shadowsEnabledRef = useRef(true)
  const smoothingEnabledRef = useRef(true)
  const smoothingAngleThresholdRef = useRef(50)
  const sheenRef = useRef(0.5)
  const bumpIntensityRef = useRef(0.5)
  const demoModeRef = useRef(false)
  const isDraggingRef = useRef(false)
  const lastMouseXRef = useRef(0)
  const lastMouseYRef = useRef(0)

  useEffect(() => {
    primaryLightRef.current = primaryLight
  }, [primaryLight])

  useEffect(() => {
    extraLightsRef.current = extraLights
  }, [extraLights])

  useEffect(() => {
    renderQualityRef.current = renderQuality
  }, [renderQuality])

  useEffect(() => {
    shadowQualityRef.current = shadowQuality
  }, [shadowQuality])

  useEffect(() => {
    shadowsEnabledRef.current = shadowsEnabled
  }, [shadowsEnabled])

  useEffect(() => {
    smoothingEnabledRef.current = smoothingEnabled
  }, [smoothingEnabled])

  useEffect(() => {
    smoothingAngleThresholdRef.current = smoothingAngleThreshold
  }, [smoothingAngleThreshold])

  useEffect(() => {
    sheenRef.current = sheen
  }, [sheen])

  useEffect(() => {
    bumpIntensityRef.current = bumpIntensity
  }, [bumpIntensity])

  useEffect(() => {
    objectSettingsRef.current = objectSettings
  }, [objectSettings])

  useEffect(() => {
    objectColorRef.current = objectColor
  }, [objectColor])

  useEffect(() => {
    demoModeRef.current = demoMode
  }, [demoMode])

  useEffect(() => {
    const handleWindowMouseMove = (event: MouseEvent) => {
      if (!isDraggingRef.current) {
        return
      }
      const deltaX = event.clientX - lastMouseXRef.current
      const deltaY = event.clientY - lastMouseYRef.current
      lastMouseXRef.current = event.clientX
      lastMouseYRef.current = event.clientY

      setObjectSettings((current) => ({
        ...current,
        rotationY: current.rotationY + deltaX * 0.5,
        rotationX: current.rotationX - deltaY * 0.5,
      }))
    }

    const handleWindowMouseUp = () => {
      isDraggingRef.current = false
    }

    window.addEventListener('mousemove', handleWindowMouseMove)
    window.addEventListener('mouseup', handleWindowMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove)
      window.removeEventListener('mouseup', handleWindowMouseUp)
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) {
      return
    }

    const handleCanvasWheel = (event: WheelEvent) => {
      event.preventDefault()
      const delta = event.deltaY > 0 ? -0.05 : 0.05
      setObjectSettings((current) => ({
        ...current,
        scale: Math.min(3, Math.max(0.2, current.scale + delta)),
      }))
    }

    canvas.addEventListener('wheel', handleCanvasWheel, { passive: false })
    return () => {
      canvas.removeEventListener('wheel', handleCanvasWheel)
    }
  }, [rendererMode])

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) {
      return
    }

    let renderer: RendererBackend
    let backendStatus = 'GPU renderer ready'

    const webglProbe = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    })

    if (rendererMode === 'software') {
      renderer = new SoftwareRenderer(canvas)
      backendStatus = 'Software renderer forced'
    } else if (rendererMode === 'gpu') {
      if (webglProbe !== null) {
        renderer = new WebGLRenderer(canvas)
        backendStatus = 'GPU renderer forced'
      } else {
        renderer = new SoftwareRenderer(canvas)
        backendStatus = 'GPU unavailable, software fallback active'
      }
    } else if (webglProbe !== null) {
      renderer = new WebGLRenderer(canvas)
    } else {
      renderer = new SoftwareRenderer(canvas)
      backendStatus = 'Software fallback active'
    }

    rendererRef.current = renderer
    setStatus(backendStatus)

    let cachedCssWidth = 0
    let cachedCssHeight = 0
    let appliedDevicePixelRatio = 0
    let appliedRenderQuality = -1

    const resizeCanvas = () => {
      const { width, height } = canvas.getBoundingClientRect()
      cachedCssWidth = width
      cachedCssHeight = height
      appliedDevicePixelRatio = window.devicePixelRatio || 1
      appliedRenderQuality = renderQualityRef.current
      renderer.resize(width, height, appliedDevicePixelRatio, appliedRenderQuality)
    }

    resizeCanvas()

    const resizeObserver = new ResizeObserver(resizeCanvas)
    resizeObserver.observe(canvas)

    let lastTimestamp = performance.now()
    let frameCounter = 0
    let fpsWindowStart = lastTimestamp
    let animationFrame = 0
    let mounted = true

    const loop = (timestamp: number) => {
      if (!mounted) {
        return
      }

      const elapsed = Math.min(100, timestamp - lastTimestamp)
      lastTimestamp = timestamp

      const currentPrimaryLight = primaryLightRef.current
      const currentExtraLights = extraLightsRef.current
      const allLights = [currentPrimaryLight, ...currentExtraLights].slice(0, MAX_POINT_LIGHTS)
      const safePrimaryLightPosition = [
        currentPrimaryLight.x,
        currentPrimaryLight.y,
        Math.min(currentPrimaryLight.z, MAX_LIGHT_Z),
      ] as const

      sceneRef.current.update(elapsed / 1000)
      const currentObjectSettings = objectSettingsRef.current
      if (demoModeRef.current) {
        currentObjectSettings.rotationX = (currentObjectSettings.rotationX + elapsed * 0.02) % 360
        currentObjectSettings.rotationY = (currentObjectSettings.rotationY + elapsed * 0.03) % 360
        currentObjectSettings.rotationZ = (currentObjectSettings.rotationZ + elapsed * 0.015) % 360
      }
      sceneRef.current.setPrimaryTransform(
        [
          currentObjectSettings.positionX,
          currentObjectSettings.positionY,
          currentObjectSettings.positionZ,
        ],
        [
          (currentObjectSettings.rotationX * Math.PI) / 180,
          (currentObjectSettings.rotationY * Math.PI) / 180,
          (currentObjectSettings.rotationZ * Math.PI) / 180,
        ],
        currentObjectSettings.scale,
      )
      sceneRef.current.setLightMarkerVisible(currentObjectSettings.showLightMarker && currentPrimaryLight.showMarker)
      sceneRef.current.setPrimaryColor(objectColorRef.current)
      sceneRef.current.setLightMarkerColor(currentPrimaryLight.color)
      sceneRef.current.setLightMarkerPosition([
        safePrimaryLightPosition[0],
        safePrimaryLightPosition[1],
        safePrimaryLightPosition[2],
      ])

      const currentDevicePixelRatio = window.devicePixelRatio || 1
      const currentRenderQuality = renderQualityRef.current
      if (
        currentDevicePixelRatio !== appliedDevicePixelRatio ||
        currentRenderQuality !== appliedRenderQuality
      ) {
        appliedDevicePixelRatio = currentDevicePixelRatio
        appliedRenderQuality = currentRenderQuality
        renderer.resize(cachedCssWidth, cachedCssHeight, currentDevicePixelRatio, currentRenderQuality)
      }

      renderer.render({
        objects: sceneRef.current.getRenderableObjects(),
        background: '#000000',
        cameraPosition: [0, 0.25, 7],
        cameraTarget: [0, 0, 0],
        cameraUp: [0, 1, 0],
        lights: allLights.map((light) => ({
          position: [light.x, light.y, Math.min(light.z, MAX_LIGHT_Z)] as [number, number, number],
          color: light.color,
          intensity: light.brightness,
        })),
        shadowQuality: shadowsEnabledRef.current ? shadowQualityRef.current : 0,
        smoothShading: smoothingEnabledRef.current,
        smoothingAngleThresholdDegrees: smoothingAngleThresholdRef.current,
        sheen: sheenRef.current,
        bumpIntensity: bumpIntensityRef.current,
        fieldOfView: Math.PI / 3,
      })

      frameCounter += 1
      if (timestamp - fpsWindowStart >= 1000) {
        const measuredFps = Math.round((frameCounter * 1000) / (timestamp - fpsWindowStart))
        setStatus(`${measuredFps} FPS live`)
        frameCounter = 0
        fpsWindowStart = timestamp
      }

      animationFrame = window.requestAnimationFrame(loop)
    }

    animationFrame = window.requestAnimationFrame(loop)

    return () => {
      mounted = false
      window.cancelAnimationFrame(animationFrame)
      resizeObserver.disconnect()
      renderer.dispose()
      rendererRef.current = null
    }
  }, [rendererMode])

  const updateLight = (
    index: number,
    key: keyof PointLightSettings,
    value: string | number | boolean,
  ) => {
    if (index === 0) {
      setPrimaryLight((current) => ({
        ...current,
        [key]: value,
      }))
      return
    }

    setExtraLights((current) =>
      current.map((light, lightIndex) =>
        lightIndex === index - 1
          ? {
              ...light,
              [key]: value,
            }
          : light,
      ),
    )
  }

  const handleLightChange = (index: number, key: keyof PointLightSettings) => (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const value = Number.parseFloat(event.target.value)
    updateLight(index, key, key === 'z' ? Math.min(value, MAX_LIGHT_Z) : value)
  }

  const handleQualityChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setRenderQuality(Number.parseFloat(event.target.value))
  }

  const handleRendererModeChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setRendererMode(event.target.value as RendererMode)
  }

  const handleShadowQualityChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setShadowQuality(Number.parseFloat(event.target.value))
  }

  const handleShadowsEnabledChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setShadowsEnabled(event.target.checked)
  }

  const handleSmoothingEnabledChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setSmoothingEnabled(event.target.checked)
  }

  const handleSmoothingAngleThresholdChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setSmoothingAngleThreshold(Number.parseFloat(event.target.value))
  }

  const handleSheenChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setSheen(Number.parseFloat(event.target.value))
  }

  const handleBumpIntensityChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setBumpIntensity(Number.parseFloat(event.target.value))
  }

  const handleLightColorChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const color = event.target.value
    updateLight(0, 'color', color)
  }

  const handleObjectColorChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setObjectColor(event.target.value)
  }

  const handleDemoModeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setDemoMode(event.target.checked)
  }

  const handleCanvasMouseDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
    event.preventDefault()
    isDraggingRef.current = true
    lastMouseXRef.current = event.clientX
    lastMouseYRef.current = event.clientY
    if (demoModeRef.current) {
      setDemoMode(false)
    }
  }

  const handleGeneratorChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedGenerator(event.target.value as ObjectGeneratorId)
  }

  const handleGenerateObject = () => {
    const generator = OBJECT_GENERATORS.find((option) => option.id === selectedGenerator)
    if (generator === undefined) {
      return
    }

    const mesh = generator.generate(objectColorRef.current)
    const normalizedMesh = normalizeMeshForViewport(mesh)
    setHasBumpMap(false)
    setModelName(mesh.name)
    sceneRef.current.setPrimaryMesh(normalizedMesh)
    setObjectSettings((current) => ({
      ...current,
      positionX: INITIAL_OBJECT_SETTINGS.positionX,
      positionY: INITIAL_OBJECT_SETTINGS.positionY,
      positionZ: INITIAL_OBJECT_SETTINGS.positionZ,
      rotationX: INITIAL_OBJECT_SETTINGS.rotationX,
      rotationY: INITIAL_OBJECT_SETTINGS.rotationY,
      rotationZ: INITIAL_OBJECT_SETTINGS.rotationZ,
      scale: INITIAL_OBJECT_SETTINGS.scale,
    }))
    setStatus(`Generated ${mesh.name}`)
  }

  const handleObjFileLoad = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    if (files.length === 0) {
      return
    }

    try {
      const objFile = files.find((file) => file.name.toLowerCase().endsWith('.obj'))
      if (objFile === undefined) {
        throw new Error('Please select an OBJ file. You can optionally include MTL and texture image files too.')
      }

      const objText = await objFile.text()
      const referencedLibraries = new Set(
        parseObjMaterialLibraries(objText).map((libraryName) => normalizeResourceName(libraryName)),
      )

      const candidateMtlFiles = files.filter((file) => {
        const fileName = file.name.toLowerCase()
        return fileName.endsWith('.mtl') || fileName.endsWith('.mlt')
      })

      const matchedMtlFiles =
        referencedLibraries.size > 0
          ? candidateMtlFiles.filter((file) => referencedLibraries.has(normalizeResourceName(file.name)))
          : candidateMtlFiles

      const mtlFiles = matchedMtlFiles.length > 0 ? matchedMtlFiles : candidateMtlFiles

      const materialMap: Record<string, ParsedMtlMaterial> = {}
      for (const mtlFile of mtlFiles) {
        const mtlText = await mtlFile.text()
        const parsedMaterials = parseMtlMaterials(mtlText)
        Object.assign(materialMap, parsedMaterials)
      }

      const modelName = objFile.name.replace(/\.[^/.]+$/, '')
      setModelName(modelName)
      const textureFiles = files.filter((file) => isTextureFile(file.name))
      const textureMap: Record<string, TextureData> = {}
      for (const textureFile of textureFiles) {
        const textureData = await loadTextureData(textureFile)
        textureMap[normalizeResourceName(textureFile.name)] = textureData
      }

      const parsedMesh = parseObjMesh(
        objText,
        modelName,
        objectColorRef.current,
        materialMap,
        textureMap,
      )
      const normalizedMesh = normalizeMeshForViewport(parsedMesh)
      setHasBumpMap(normalizedMesh.bumpMapData !== undefined)

      sceneRef.current.setPrimaryMesh(normalizedMesh)
      setObjectSettings((current) => ({
        ...current,
        positionX: INITIAL_OBJECT_SETTINGS.positionX,
        positionY: INITIAL_OBJECT_SETTINGS.positionY,
        positionZ: INITIAL_OBJECT_SETTINGS.positionZ,
        rotationX: INITIAL_OBJECT_SETTINGS.rotationX,
        rotationY: INITIAL_OBJECT_SETTINGS.rotationY,
        rotationZ: INITIAL_OBJECT_SETTINGS.rotationZ,
        scale: INITIAL_OBJECT_SETTINGS.scale,
      }))

      if (primaryLightRef.current.brightness <= 0) {
        setPrimaryLight((current) => ({
          ...current,
          brightness: 1,
        }))
        setStatus(`Loaded ${objFile.name} (brightness reset to 1.00)`)
      } else {
        setStatus(
          mtlFiles.length > 0 || textureFiles.length > 0
            ? `Loaded ${objFile.name} with ${mtlFiles.length} MTL and ${textureFiles.length} texture file(s)`
            : `Loaded ${objFile.name}`,
        )
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load OBJ file.'
      setStatus(message)
    } finally {
      event.target.value = ''
    }
  }

  const handleObjectNumberChange =
    (key: Exclude<keyof ObjectSettings, 'showLightMarker'>) =>
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const value = Number.parseFloat(event.target.value)
      setObjectSettings((current) => ({
        ...current,
        [key]: value,
      }))
    }

  const handleLightMarkerToggle = (event: React.ChangeEvent<HTMLInputElement>) => {
    const checked = event.target.checked
    setObjectSettings((current) => ({
      ...current,
      showLightMarker: checked,
    }))
    updateLight(0, 'showMarker', checked)
  }

  const addLight = () => {
    setExtraLights((current) => {
      if (1 + current.length >= MAX_POINT_LIGHTS) {
        return current
      }

      const offset = current.length + 1
      return [
        ...current,
        {
          id: `light-${offset + 1}`,
          x: offset * 1.6,
          y: 0.25,
          z: 5.5 - offset,
          brightness: 1,
          color: '#ffffff',
          showMarker: false,
        },
      ]
    })
  }

  const removeLight = (index: number) => {
    if (index === 0) {
      return
    }

    setExtraLights((current) => current.filter((_, lightIndex) => lightIndex !== index - 1))
  }

  const formatLightValue = (value: number) => value.toFixed(2)
  const toggleQualitySection = () => setQualitySectionCollapsed((current) => !current)
  const toggleLightingSection = () => setLightingSectionCollapsed((current) => !current)
  const toggleTransformSection = () => setTransformSectionCollapsed((current) => !current)

  const startResize = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    isResizingRef.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isResizingRef.current) {
        return
      }
      const newWidth = Math.min(
        MAX_PANEL_WIDTH,
        Math.max(MIN_PANEL_WIDTH, moveEvent.clientX),
      )
      setPanelWidth(newWidth)
    }

    const handleMouseUp = () => {
      isResizingRef.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
  }

  return (
    <main className="app-shell" style={{ '--panel-width': `${panelWidth}px` } as CSSProperties}>
      <aside className="controls-panel" aria-label="Renderer controls">
        <div className="controls-scroll">
          <label className="slider-field slider-field--wide slider-field--compact file-field">
            <span>Load OBJ/MTL/Texture files</span>
            <input
              type="file"
              accept=".obj,.mtl,.mlt,.jpg,.jpeg,.png,.webp,.bmp,.gif"
              multiple
              onChange={handleObjFileLoad}
            />
          </label>
          <section className="quality-controls" aria-label="Object generation">
            <div className="light-controls__header">
              <p className="eyebrow">Generate Object</p>
            </div>
            <label className="slider-field slider-field--wide slider-field--compact mode-field">
              <span>Object type</span>
              <select value={selectedGenerator} onChange={handleGeneratorChange}>
                <optgroup label="Primitives">
                  {OBJECT_GENERATORS.filter((option) => option.category === 'Primitives').map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Complex">
                  {OBJECT_GENERATORS.filter((option) => option.category === 'Complex').map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Fun">
                  {OBJECT_GENERATORS.filter((option) => option.category === 'Fun').map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Fractals">
                  {OBJECT_GENERATORS.filter((option) => option.category === 'Fractals').map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              </select>
            </label>
            <button
              type="button"
              className="generate-button"
              onClick={handleGenerateObject}
            >
              Generate Object
            </button>
          </section>
          <section className="quality-controls" aria-label="Render quality">
            <div className="light-controls__header">
              <button
                type="button"
                className="section-toggle"
                onClick={toggleQualitySection}
                aria-expanded={!qualitySectionCollapsed}
              >
                <span className="section-toggle__icon">{qualitySectionCollapsed ? '+' : '-'}</span>
                <p className="eyebrow">Performance</p>
              </button>
              <span className="status-chip">{renderQuality.toFixed(2)}x</span>
            </div>

            {!qualitySectionCollapsed && (
              <>

            <label className="slider-field slider-field--wide slider-field--compact mode-field">
              <span>Renderer mode</span>
              <select value={rendererMode} onChange={handleRendererModeChange}>
                <option value="auto">Auto</option>
                <option value="software">Software</option>
                <option value="gpu">GPU</option>
              </select>
            </label>

            <label className="slider-field slider-field--wide slider-field--compact">
              <span>
                Quality scale <strong>{renderQuality.toFixed(2)}x</strong>
              </span>
              <input
                type="range"
                min={MIN_RENDER_QUALITY.toString()}
                max={MAX_RENDER_QUALITY.toString()}
                step="0.05"
                value={renderQuality}
                onChange={handleQualityChange}
              />
            </label>

            <label className="slider-field slider-field--wide slider-field--compact">
            
              <label className="toggle-field slider-field--wide slider-field--compact">
                <span>Shadows</span>
                <input type="checkbox" checked={shadowsEnabled} onChange={handleShadowsEnabledChange} />
              </label>

              <span>
                Shadow quality <strong>{Math.round((shadowQuality / MAX_SHADOW_QUALITY) * 100)}%</strong>
              </span>
              <input
                type="range"
                min={MIN_SHADOW_QUALITY.toString()}
                max={MAX_SHADOW_QUALITY.toString()}
                step="0.05"
                value={shadowQuality}
                onChange={handleShadowQualityChange}
                disabled={!shadowsEnabled}
              />
            </label>

            <label className="slider-field slider-field--wide slider-field--compact">

              <label className="toggle-field slider-field--wide slider-field--compact">
                <span>Smooth shading</span>
                <input
                  type="checkbox"
                  checked={smoothingEnabled}
                  onChange={handleSmoothingEnabledChange}
                />
              </label>

              <span>
                Smoothing angle <strong>{Math.round(smoothingAngleThreshold)}deg</strong>
              </span>
              <input
                type="range"
                min={MIN_SMOOTHING_ANGLE.toString()}
                max={MAX_SMOOTHING_ANGLE.toString()}
                step="1"
                value={smoothingAngleThreshold}
                onChange={handleSmoothingAngleThresholdChange}
                disabled={!smoothingEnabled}
              />
            </label>
              </>
            )}
          </section>

          <section className="light-controls" aria-label="Light controls">
            <div className="light-controls__header">
              <button
                type="button"
                className="section-toggle"
                onClick={toggleLightingSection}
                aria-expanded={!lightingSectionCollapsed}
              >
                <span className="section-toggle__icon">{lightingSectionCollapsed ? '+' : '-'}</span>
                <p className="eyebrow">Lighting</p>
              </button>
              <button className="status-chip" type="button" onClick={addLight} disabled={1 + extraLights.length >= MAX_POINT_LIGHTS}>
                Add light
              </button>
            </div>

            {!lightingSectionCollapsed && (
              <>

            <div className="light-grid">
              <label className="slider-field slider-field--compact">
                <span>
                  X <strong>{formatLightValue(primaryLight.x)}</strong>
                </span>
                <input
                  type="range"
                  min="-10"
                  max="10"
                  step="0.1"
                  value={primaryLight.x}
                  onChange={handleLightChange(0, 'x')}
                />
              </label>

              <label className="slider-field slider-field--compact">
                <span>
                  Y <strong>{formatLightValue(primaryLight.y)}</strong>
                </span>
                <input
                  type="range"
                  min="-10"
                  max="10"
                  step="0.1"
                  value={primaryLight.y}
                  onChange={handleLightChange(0, 'y')}
                />
              </label>

              <label className="slider-field slider-field--compact">
                <span>
                  Z <strong>{formatLightValue(primaryLight.z)}</strong>
                </span>
                <input
                  type="range"
                  min="-10"
                  max={MAX_LIGHT_Z.toString()}
                  step="0.1"
                  value={primaryLight.z}
                  onChange={handleLightChange(0, 'z')}
                />
              </label>

              <label className="slider-field slider-field--wide slider-field--compact">
                <span>
                  Brightness <strong>{formatLightValue(primaryLight.brightness)}</strong>
                </span>
                <input
                  type="range"
                  min="0"
                  max="3"
                  step="0.05"
                  value={primaryLight.brightness}
                  onChange={handleLightChange(0, 'brightness')}
                />
              </label>

              <label className="slider-field slider-field--wide slider-field--compact color-picker-field">
                <span>
                  Light color <strong>{primaryLight.color.toUpperCase()}</strong>
                </span>
                <input type="color" value={primaryLight.color} onChange={handleLightColorChange} />
              </label>

              <label className="toggle-field slider-field--wide slider-field--compact">
                <span>Show light source indicator</span>
                <input
                  type="checkbox"
                  checked={objectSettings.showLightMarker && primaryLight.showMarker}
                  onChange={handleLightMarkerToggle}
                />
              </label>
            </div>

            {extraLights.length > 0 && (
              <div className="extra-light-list">
                {extraLights.map((light, index) => (
                  <section className="extra-light-card" key={light.id} aria-label={`Extra light ${index + 1}`}>
                    <div className="light-controls__header">
                      <div>
                        <p className="eyebrow">Light {index + 2}</p>
                      </div>
                      <button className="status-chip" type="button" onClick={() => removeLight(index + 1)}>
                        Remove
                      </button>
                    </div>

                    <div className="light-grid">
                      <label className="slider-field slider-field--compact">
                        <span>
                          X <strong>{formatLightValue(light.x)}</strong>
                        </span>
                        <input
                          type="range"
                          min="-10"
                          max="10"
                          step="0.1"
                          value={light.x}
                          onChange={handleLightChange(index + 1, 'x')}
                        />
                      </label>

                      <label className="slider-field slider-field--compact">
                        <span>
                          Y <strong>{formatLightValue(light.y)}</strong>
                        </span>
                        <input
                          type="range"
                          min="-10"
                          max="10"
                          step="0.1"
                          value={light.y}
                          onChange={handleLightChange(index + 1, 'y')}
                        />
                      </label>

                      <label className="slider-field slider-field--compact">
                        <span>
                          Z <strong>{formatLightValue(light.z)}</strong>
                        </span>
                        <input
                          type="range"
                          min="-10"
                          max={MAX_LIGHT_Z.toString()}
                          step="0.1"
                          value={light.z}
                          onChange={handleLightChange(index + 1, 'z')}
                        />
                      </label>

                      <label className="slider-field slider-field--wide slider-field--compact">
                        <span>
                          Brightness <strong>{formatLightValue(light.brightness)}</strong>
                        </span>
                        <input
                          type="range"
                          min="0"
                          max="3"
                          step="0.05"
                          value={light.brightness}
                          onChange={handleLightChange(index + 1, 'brightness')}
                        />
                      </label>

                      <label className="slider-field slider-field--wide slider-field--compact color-picker-field">
                        <span>
                          Light color <strong>{light.color.toUpperCase()}</strong>
                        </span>
                        <input
                          type="color"
                          value={light.color}
                          onChange={(event) => updateLight(index + 1, 'color', event.target.value)}
                        />
                      </label>
                    </div>
                  </section>
                ))}
              </div>
            )}
              </>
            )}
          </section>

          <section className="light-controls" aria-label="Object transform controls">
            <div className="light-controls__header">
              <button
                type="button"
                className="section-toggle"
                onClick={toggleTransformSection}
                aria-expanded={!transformSectionCollapsed}
              >
                <span className="section-toggle__icon">{transformSectionCollapsed ? '+' : '-'}</span>
                <p className="eyebrow">Object Transform</p>
              </button>
              <span className="status-chip">Manual</span>
            </div>

            {!transformSectionCollapsed && (
            <>
            <label className="toggle-field slider-field--wide slider-field--compact">
              <span>Demo mode (auto-rotate)</span>
              <input type="checkbox" checked={demoMode} onChange={handleDemoModeChange} />
            </label>

            <div className="light-grid">
              <label className="slider-field slider-field--compact">
                <span>
                  Position X <strong>{formatLightValue(objectSettings.positionX)}</strong>
                </span>
                <input
                  type="range"
                  min="-4"
                  max="4"
                  step="0.05"
                  value={objectSettings.positionX}
                  onChange={handleObjectNumberChange('positionX')}
                />
              </label>

              <label className="slider-field slider-field--compact">
                <span>
                  Position Y <strong>{formatLightValue(objectSettings.positionY)}</strong>
                </span>
                <input
                  type="range"
                  min="-4"
                  max="4"
                  step="0.05"
                  value={objectSettings.positionY}
                  onChange={handleObjectNumberChange('positionY')}
                />
              </label>

              <label className="slider-field slider-field--wide slider-field--compact">
                <span>
                  Position Z <strong>{formatLightValue(objectSettings.positionZ)}</strong>
                </span>
                <input
                  type="range"
                  min="-4"
                  max="4"
                  step="0.05"
                  value={objectSettings.positionZ}
                  onChange={handleObjectNumberChange('positionZ')}
                />
              </label>

              <label className="slider-field slider-field--compact">
                <span>
                  Rotation X <strong>{formatLightValue(objectSettings.rotationX)}deg</strong>
                </span>
                <input
                  type="range"
                  min="-180"
                  max="180"
                  step="1"
                  value={objectSettings.rotationX}
                  onChange={handleObjectNumberChange('rotationX')}
                  disabled={demoMode}
                />
              </label>

              <label className="slider-field slider-field--compact">
                <span>
                  Rotation Y <strong>{formatLightValue(objectSettings.rotationY)}deg</strong>
                </span>
                <input
                  type="range"
                  min="-180"
                  max="180"
                  step="1"
                  value={objectSettings.rotationY}
                  onChange={handleObjectNumberChange('rotationY')}
                  disabled={demoMode}
                />
              </label>

              <label className="slider-field slider-field--wide slider-field--compact">
                <span>
                  Rotation Z <strong>{formatLightValue(objectSettings.rotationZ)}deg</strong>
                </span>
                <input
                  type="range"
                  min="-180"
                  max="180"
                  step="1"
                  value={objectSettings.rotationZ}
                  onChange={handleObjectNumberChange('rotationZ')}
                  disabled={demoMode}
                />
              </label>

              <label className="slider-field slider-field--wide slider-field--compact">
                <span>
                  Scale <strong>{formatLightValue(objectSettings.scale)}x</strong>
                </span>
                <input
                  type="range"
                  min="0.2"
                  max="3"
                  step="0.02"
                  value={objectSettings.scale}
                  onChange={handleObjectNumberChange('scale')}
                />
              </label>

              <label className="slider-field slider-field--wide slider-field--compact color-picker-field">
                <span>
                  Object color <strong>{objectColor.toUpperCase()}</strong>
                </span>
                <input type="color" value={objectColor} onChange={handleObjectColorChange} />
              </label>

              <label className="slider-field slider-field--wide slider-field--compact">
                <span>
                  Sheen <strong>{sheen <= 0.05 ? 'Matte' : sheen >= 0.95 ? 'Polished' : `${Math.round(sheen * 100)}%`}</strong>
                </span>
                <input
                  type="range"
                  min={MIN_SHEEN.toString()}
                  max={MAX_SHEEN.toString()}
                  step="0.01"
                  value={sheen}
                  onChange={handleSheenChange}
                />
              </label>

              <label className="slider-field slider-field--wide slider-field--compact">
                <span>
                  Bump intensity <strong>{hasBumpMap ? `${Math.round(bumpIntensity * 100)}%` : 'No bump map'}</strong>
                </span>
                <input
                  type="range"
                  min={MIN_BUMP_INTENSITY.toString()}
                  max={MAX_BUMP_INTENSITY.toString()}
                  step="0.01"
                  value={bumpIntensity}
                  onChange={handleBumpIntensityChange}
                  disabled={!hasBumpMap}
                />
              </label>
            </div>
            </>
            )}
          </section>
        </div>
      </aside>

      <div
        className="resize-bar"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize controls panel"
        onMouseDown={startResize}
      />

      <section className="viewport-panel">
        <div className="viewport-header">
          <div className="light-controls__header">
            <div>
              <p className="eyebrow">Renderer output</p>
              <h2>{modelName} raster view</h2>
            </div>
            <div className="status-chip">{status}</div>
          </div>
        </div>

        <div className="canvas-frame">
          <canvas
            key={rendererMode}
            ref={canvasRef}
            className="renderer-canvas"
            aria-label="3D renderer viewport"
            onMouseDown={handleCanvasMouseDown}
          />
        </div>
      </section>
    </main>
  )
}

export default App
