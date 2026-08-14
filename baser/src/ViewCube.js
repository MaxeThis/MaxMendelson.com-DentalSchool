/**
 * ViewCube.js
 * Interactive 3D View Cube (Gizmo) for camera orientation.
 */

import * as THREE from 'three';

export class ViewCube {
    constructor(canvas, mainCamera, mainControls, onFaceClick) {
        this.canvas = canvas;
        this.mainCamera = mainCamera;
        this.mainControls = mainControls;
        this.onFaceClick = onFaceClick;

        this.scene = new THREE.Scene();
        // Clear background
        this.scene.background = null;

        // Cube specific camera
        this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
        this.camera.position.set(0, 0, 5);

        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            alpha: true,
            antialias: true
        });

        // Match parent size (canvas is styled by CSS)
        const rect = this.canvas.getBoundingClientRect();
        this.renderer.setSize(rect.width, rect.height);
        this.renderer.setPixelRatio(window.devicePixelRatio);

        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();

        this.initObject();
        this.initEvents();
    }

    initObject() {
        // Create the cube wrapper to rotate
        this.wrapper = new THREE.Object3D();
        this.scene.add(this.wrapper);

        // --- 1. The Box with Labels ---
        const size = 2; // Size of the cube
        const geometry = new THREE.BoxGeometry(size, size, size);

        // Materials for each face
        // Order: Right(px), Left(nx), Top(py), Bottom(ny), Front(pz), Back(nz)
        const faces = [
            { text: 'RIGHT', color: 0xff4444, view: 'right' },
            { text: 'LEFT', color: 0xff4444, view: 'left' },
            { text: 'TOP', color: 0x44ff44, view: 'top' },
            { text: 'BOTTOM', color: 0x44ff44, view: 'bottom' },
            { text: 'FRONT', color: 0x4444ff, view: 'front' },
            { text: 'BACK', color: 0x4444ff, view: 'back' }
        ];

        const materials = faces.map(face => this.createFaceMaterial(face.text));

        this.cube = new THREE.Mesh(geometry, materials);
        this.cube.name = 'ViewCube';

        // Store view data on the mesh for raycasting
        // Since materials are per face, raycaster faceIndex tells us which one.
        this.cube.userData.views = faces.map(f => f.view);

        this.wrapper.add(this.cube);

        // Each label is painted once into a canvas. If that happens before
        // the typeface has finished loading, the paint uses a fallback and
        // keeps it for good, so the labels are painted again once the font
        // is really there.
        document.fonts?.ready.then(() => {
            faces.forEach((face, index) => {
                const material = this.cube.material[index];
                const fresh = this.createFaceMaterial(face.text);
                material.map?.dispose();
                material.map = fresh.map;
                material.needsUpdate = true;
                fresh.dispose();
            });
        });

        // --- 2. Axes Helpers (Optional visual flair) ---
        // We can add small cones/cylinders for axes if we want to look like Blender exactly,
        // but just the box is a good start as requested by "cube".

        // Ambient light for the cube
        const ambient = new THREE.AmbientLight(0xffffff, 1.0);
        this.scene.add(ambient);
    }

    createFaceMaterial(text) {
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 128;
        const ctx = canvas.getContext('2d');

        // Glass Gradient Background
        const gradient = ctx.createLinearGradient(0, 0, 128, 128);
        gradient.addColorStop(0, 'rgba(255, 255, 255, 0.25)'); // Light top-left
        gradient.addColorStop(0.5, 'rgba(255, 255, 255, 0.1)'); // Transparent middle
        gradient.addColorStop(1, 'rgba(255, 255, 255, 0.05)'); // Darker bottom-right

        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 128, 128);

        // Glass Border (simulated light edge)
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.lineWidth = 4;
        ctx.strokeRect(0, 0, 128, 128);

        // Inner Highlight (top-left)
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(128, 0);
        ctx.lineTo(0, 0);
        ctx.lineTo(0, 128);
        ctx.stroke();

        // Text
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        // Ask for a face the app actually ships. Inter was named here once
        // and never shipped, so the cube quietly used whatever the system
        // had while the rest of the window used Instrument Sans.
        ctx.font = "bold 24px 'Instrument Sans', sans-serif";
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
        ctx.shadowBlur = 4;
        ctx.fillText(text, 64, 64);

        const texture = new THREE.CanvasTexture(canvas);

        return new THREE.MeshBasicMaterial({
            map: texture,
            color: 0xffffff,
            transparent: true,
            opacity: 0.85,
            side: THREE.DoubleSide,
            depthWrite: false // Helps with transparency sorting
        });
    }

    initEvents() {
        this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
        this.canvas.addEventListener('click', (e) => this.onClick(e));
        this.canvas.addEventListener('mouseleave', () => this.onMouseLeave());
    }

    getMouseCoords(e) {
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
            y: -((e.clientY - rect.top) / rect.height) * 2 + 1
        };
    }

    onMouseMove(e) {
        const coords = this.getMouseCoords(e);
        this.mouse.set(coords.x, coords.y);

        this.raycaster.setFromCamera(this.mouse, this.camera);
        const intersects = this.raycaster.intersectObject(this.cube);

        if (intersects.length > 0) {
            this.canvas.style.cursor = 'pointer';
            // Hover effect could be added here (e.g. changing material color)
            // For now just cursor change
        } else {
            this.canvas.style.cursor = 'default';
        }
    }

    onMouseLeave() {
        this.canvas.style.cursor = 'default';
    }

    onClick(e) {
        const coords = this.getMouseCoords(e);
        this.mouse.set(coords.x, coords.y);

        this.raycaster.setFromCamera(this.mouse, this.camera);
        const intersects = this.raycaster.intersectObject(this.cube);

        if (intersects.length > 0) {
            const faceIndex = intersects[0].face.materialIndex;
            const view = this.cube.userData.views[faceIndex];
            if (this.onFaceClick) {
                this.onFaceClick(view);
            }
        }
    }

    animate(referenceCamera) {
        // match rotation of main camera
        // The ViewCube should show the orientation of the object relative to the camera.
        // If we rotate the camera around the object, the object appears to rotate.
        // Actually simplest way: Set ViewCube camera to same position as main camera (normalized)

        // Use passed camera if provided, otherwise default to stored one
        const cameraToTrack = referenceCamera || this.mainCamera;

        // 1. Get direction from target to camera
        const position = cameraToTrack.position.clone();
        const target = this.mainControls.target.clone();

        // Direction vector (normalized)
        const dir = new THREE.Vector3().subVectors(position, target).normalize();

        // Distance for the view cube camera
        const dist = 5;
        this.camera.position.copy(dir.clone().multiplyScalar(dist));
        this.camera.lookAt(0, 0, 0);
        this.camera.up.copy(cameraToTrack.up);

        // 2. Update face opacities based on facing direction
        // Face normals in local space (cube is axis-aligned):
        // Order: Right(+X), Left(-X), Top(+Y), Bottom(-Y), Front(+Z), Back(-Z)
        const faceNormals = [
            new THREE.Vector3(1, 0, 0),   // Right
            new THREE.Vector3(-1, 0, 0),  // Left
            new THREE.Vector3(0, 1, 0),   // Top
            new THREE.Vector3(0, -1, 0),  // Bottom
            new THREE.Vector3(0, 0, 1),   // Front
            new THREE.Vector3(0, 0, -1)   // Back
        ];

        // Camera direction in view cube space (pointing at origin from camera position)
        const camDir = dir.clone().negate(); // Direction FROM camera TO cube center

        // For each face, calculate how much it faces the camera
        const materials = this.cube.material;
        for (let i = 0; i < 6; i++) {
            const normal = faceNormals[i];
            // Dot product: 1 = facing camera, -1 = facing away, 0 = perpendicular
            const dot = normal.dot(dir);

            // Map dot product to opacity:
            // dot > 0 means face is facing toward camera (visible)
            // dot < 0 means face is facing away (back-facing, should fade)
            // Range: facing camera (dot=1) -> opacity 0.9
            //        perpendicular (dot=0) -> opacity 0.5
            //        facing away (dot=-1) -> opacity 0.1

            const minOpacity = 0.1;
            const maxOpacity = 0.9;
            // Remap from [-1, 1] to [minOpacity, maxOpacity]
            const opacity = minOpacity + (maxOpacity - minOpacity) * ((dot + 1) / 2);

            materials[i].opacity = opacity;
        }

        // Render
        this.renderer.render(this.scene, this.camera);
    }

    resize() {
        // Match parent size
        const rect = this.canvas.getBoundingClientRect();
        this.renderer.setSize(rect.width, rect.height);
        this.renderer.setPixelRatio(window.devicePixelRatio);

        // Update camera aspect
        this.camera.aspect = rect.width / rect.height;
        this.camera.updateProjectionMatrix();
    }
}
