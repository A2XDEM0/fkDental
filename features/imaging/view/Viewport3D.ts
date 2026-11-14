import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import type { SurfaceMesh, Vec3 } from '../types';

export interface ViewportMarker {
  position: Vec3;
  label: string;
  color: string;
}

export interface MeshStyle {
  color: string;
  roughness?: number;
  accelerate?: boolean; // 为点选建立 BVH；百万级三角面的 CBCT 表面不建，直接遍历即可
}

export type ViewPreset = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

export interface PickEvent {
  layer: string;
  world: Vec3;
  local: Vec3;
}

const PRESET_DIRECTIONS: Record<ViewPreset, { dir: Vec3; up: Vec3 }> = {
  // 患者坐标系 LPS：+x 左，+y 后，+z 上。“正面”即面对患者。
  front: { dir: [0, -1, 0], up: [0, 0, 1] },
  back: { dir: [0, 1, 0], up: [0, 0, 1] },
  left: { dir: [1, 0, 0], up: [0, 0, 1] },
  right: { dir: [-1, 0, 0], up: [0, 0, 1] },
  top: { dir: [0, 0, 1], up: [0, 1, 0] },
  bottom: { dir: [0, 0, -1], up: [0, -1, 0] }
};

const labelTexture = (text: string, color: string) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 96;
  const ctx = canvas.getContext('2d')!;
  ctx.beginPath();
  ctx.arc(48, 48, 40, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 7;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = '600 50px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 48, 51);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
};

// 一个按需渲染的三维视口：管理若干命名网格图层、标记点和点选。
export class Viewport3D {
  onPick: ((event: PickEvent) => void) | null = null;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(28, 1, 0.5, 4000);
  private controls: OrbitControls;
  private layers = new Map<string, THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>>();
  private markers = new THREE.Group();
  private cursor: THREE.LineSegments;
  private resizeObserver: ResizeObserver;
  private frame = 0;
  private pointerDown: { x: number; y: number } | null = null;
  private raycaster = new THREE.Raycaster();

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.domElement.className = 'block h-full w-full touch-none';
    container.appendChild(this.renderer.domElement);

    this.camera.up.set(0, 0, 1);
    this.camera.position.set(0, -260, 60);
    this.scene.add(this.camera);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x475569, 1.15));
    const headlight = new THREE.DirectionalLight(0xffffff, 2.1);
    headlight.position.set(-0.4, 0.7, 1);
    this.camera.add(headlight);
    this.scene.add(this.markers);

    const cursorGeometry = new THREE.BufferGeometry();
    const arm = 7;
    cursorGeometry.setAttribute('position', new THREE.Float32BufferAttribute([-arm, 0, 0, arm, 0, 0, 0, -arm, 0, 0, arm, 0, 0, 0, -arm, 0, 0, arm], 3));
    this.cursor = new THREE.LineSegments(cursorGeometry, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false }));
    this.cursor.renderOrder = 5;
    this.cursor.visible = false;
    this.scene.add(this.cursor);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.rotateSpeed = 0.9;
    this.controls.zoomSpeed = 1.1;
    this.controls.addEventListener('change', this.requestRender);

    const dom = this.renderer.domElement;
    dom.addEventListener('pointerdown', this.handlePointerDown);
    dom.addEventListener('pointerup', this.handlePointerUp);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  requestRender = () => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.renderer.render(this.scene, this.camera);
    });
  };

  setMesh(key: string, mesh: SurfaceMesh | null, style?: MeshStyle) {
    const existing = this.layers.get(key);
    if (existing) {
      this.scene.remove(existing);
      existing.geometry.dispose();
      existing.material.dispose();
      this.layers.delete(key);
    }
    if (mesh && style) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      geometry.computeBoundingBox();
      const material = new THREE.MeshStandardMaterial({
        color: style.color,
        roughness: style.roughness ?? 0.55,
        metalness: 0.02,
        side: THREE.DoubleSide
      });
      const object = new THREE.Mesh(geometry, material);
      object.matrixAutoUpdate = false;
      if (style.accelerate) {
        // indirect 模式不改动索引顺序，网格数据可以继续和其他模块共享。
        geometry.boundsTree = new MeshBVH(geometry, { indirect: true });
        object.raycast = acceleratedRaycast;
      }
      this.layers.set(key, object);
      this.scene.add(object);
    }
    this.requestRender();
  }

  hasLayer(key: string) {
    return this.layers.has(key);
  }

  // 传入逐顶点颜色（线性 RGB）时覆盖底色，传 null 恢复。
  setMeshColors(key: string, colors: Float32Array | null, baseColor: string) {
    const object = this.layers.get(key);
    if (!object) return;
    if (colors) {
      object.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      object.material.vertexColors = true;
      object.material.color.set('#ffffff');
    } else {
      object.geometry.deleteAttribute('color');
      object.material.vertexColors = false;
      object.material.color.set(baseColor);
    }
    object.material.needsUpdate = true;
    this.requestRender();
  }

  setMeshMatrix(key: string, matrix: ArrayLike<number> | null) {
    const object = this.layers.get(key);
    if (!object) return;
    if (matrix) object.matrix.fromArray(matrix); else object.matrix.identity();
    object.matrixWorldNeedsUpdate = true;
    this.requestRender();
  }

  setMeshDisplay(key: string, visible: boolean, opacity = 1) {
    const object = this.layers.get(key);
    if (!object) return;
    object.visible = visible;
    const translucent = opacity < 0.995;
    object.material.transparent = translucent;
    object.material.opacity = opacity;
    object.material.depthWrite = !translucent;
    object.renderOrder = translucent ? 2 : 0;
    object.material.needsUpdate = true;
    this.requestRender();
  }

  setMarkers(markers: ViewportMarker[]) {
    for (const child of [...this.markers.children]) {
      this.markers.remove(child);
      child.traverse(node => {
        if (node instanceof THREE.Mesh) { node.geometry.dispose(); node.material.dispose(); }
        if (node instanceof THREE.Sprite) { node.material.map?.dispose(); node.material.dispose(); }
      });
    }
    for (const marker of markers) {
      const group = new THREE.Group();
      group.position.set(marker.position[0], marker.position[1], marker.position[2]);
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.55, 20, 14),
        new THREE.MeshBasicMaterial({ color: marker.color, depthTest: false, transparent: true })
      );
      dot.renderOrder = 6;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(marker.label, marker.color), depthTest: false, sizeAttenuation: false }));
      sprite.scale.setScalar(this.labelScale());
      sprite.center.set(0.5, -0.25);
      sprite.renderOrder = 7;
      group.add(dot, sprite);
      this.markers.add(group);
    }
    this.requestRender();
  }

  setCursor(position: Vec3 | null) {
    this.cursor.visible = !!position;
    if (position) this.cursor.position.set(position[0], position[1], position[2]);
    this.requestRender();
  }

  // 让相机对准指定图层（缺省为所有可见图层）的包围球。
  fit(keys?: string[], preset?: ViewPreset) {
    const box = new THREE.Box3();
    for (const [key, object] of this.layers) {
      if (keys ? !keys.includes(key) : !object.visible) continue;
      object.updateMatrixWorld(true);
      box.union(new THREE.Box3().copy(object.geometry.boundingBox!).applyMatrix4(object.matrixWorld));
    }
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const direction = preset
      ? new THREE.Vector3(...PRESET_DIRECTIONS[preset].dir)
      : this.camera.position.clone().sub(this.controls.target).normalize();
    if (preset) this.camera.up.set(...PRESET_DIRECTIONS[preset].up);
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const fit = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * this.camera.aspect));
    const distance = (sphere.radius / Math.sin(fit / 2)) * 0.86;
    this.controls.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(direction, distance);
    this.camera.near = Math.max(0.5, distance / 200);
    this.camera.far = distance * 20;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.requestRender();
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.setMarkers([]);
    for (const key of [...this.layers.keys()]) this.setMesh(key, null);
    cancelAnimationFrame(this.frame);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // 编号标签不随距离缩放，按视口高度折算成约 22 px 的固定屏幕尺寸。
  private labelScale() {
    return 22 / (1.5 * Math.max(120, this.container.clientHeight));
  }

  private resize() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (!width || !height) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    const scale = this.labelScale();
    this.markers.traverse(node => { if (node instanceof THREE.Sprite) node.scale.setScalar(scale); });
    this.renderer.render(this.scene, this.camera);
  }

  private handlePointerDown = (event: PointerEvent) => {
    this.pointerDown = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
  };

  private handlePointerUp = (event: PointerEvent) => {
    const down = this.pointerDown;
    this.pointerDown = null;
    // 拖动是旋转视角，只有原地点击才算点选。
    if (!down || !this.onPick || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    this.raycaster.firstHitOnly = true;
    let best: { layer: string; hit: THREE.Intersection } | null = null;
    for (const [layer, object] of this.layers) {
      if (!object.visible) continue;
      const hit = this.raycaster.intersectObject(object, false)[0];
      if (hit && (!best || hit.distance < best.hit.distance)) best = { layer, hit };
    }
    if (!best) return;
    const local = this.layers.get(best.layer)!.worldToLocal(best.hit.point.clone());
    this.onPick({ layer: best.layer, world: best.hit.point.toArray() as Vec3, local: local.toArray() as Vec3 });
  };
}
