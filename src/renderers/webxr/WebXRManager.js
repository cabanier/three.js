import { ArrayCamera } from '../../cameras/ArrayCamera.js';
import { EventDispatcher } from '../../core/EventDispatcher.js';
import { PerspectiveCamera } from '../../cameras/PerspectiveCamera.js';
import { Quaternion } from '../../math/Quaternion.js';
import { Vector3 } from '../../math/Vector3.js';
import { Vector4 } from '../../math/Vector4.js';
import { WebGLAnimation } from '../webgl/WebGLAnimation.js';
import { WebGLRenderTarget } from '../WebGLRenderTarget.js';
import { WebXRController } from './WebXRController.js';
import { DepthTexture } from '../../textures/DepthTexture.js';
import {
	AddEquation,
	BackSide,
	CustomBlending,
	DepthFormat,
	DepthStencilFormat,
	FrontSide,
	RGBAFormat,
	UnsignedByteType,
	UnsignedIntType,
	UnsignedInt248Type,
	ZeroFactor,
} from '../../constants.js';
import { CylinderGeometry } from '../../geometries/CylinderGeometry.js';
import { PlaneGeometry } from '../../geometries/PlaneGeometry.js';
import { MeshBasicMaterial } from '../../materials/MeshBasicMaterial.js';
import { Mesh } from '../../objects/Mesh.js';

class WebXRManager extends EventDispatcher {

	constructor( renderer, gl ) {

		super();

		const scope = this;

		let session = null;
		let framebufferScaleFactor = 1.0;

		let referenceSpace = null;
		let referenceSpaceType = 'local-floor';
		let customReferenceSpace = null;

		let pose = null;
		let glBinding = null;
		let glProjLayer = null;
		let glBaseLayer = null;
		let xrFrame = null;
		const attributes = gl.getContextAttributes();
		let initialRenderTarget = null;
		let newRenderTarget = null;

		const controllers = [];
		const controllerInputSources = [];

		const planes = new Set();
		const planesLastChangedTimes = new Map();

		//

		const cameraL = new PerspectiveCamera();
		cameraL.layers.enable( 1 );
		cameraL.viewport = new Vector4();

		const cameraR = new PerspectiveCamera();
		cameraR.layers.enable( 2 );
		cameraR.viewport = new Vector4();

		const cameras = [ cameraL, cameraR ];

		const cameraVR = new ArrayCamera();
		cameraVR.layers.enable( 1 );
		cameraVR.layers.enable( 2 );

		let _currentDepthNear = null;
		let _currentDepthFar = null;

		//

		this.cameraAutoUpdate = true;
		this.enabled = false;

		this.isPresenting = false;

		// layers/nested render target support
		let mainScene = null;
		const layers = [];
		let supportsLayers = false;
		this.drawingLayer = false;

		this.getController = function ( index ) {

			let controller = controllers[ index ];

			if ( controller === undefined ) {

				controller = new WebXRController();
				controllers[ index ] = controller;

			}

			return controller.getTargetRaySpace();

		};

		this.getControllerGrip = function ( index ) {

			let controller = controllers[ index ];

			if ( controller === undefined ) {

				controller = new WebXRController();
				controllers[ index ] = controller;

			}

			return controller.getGripSpace();

		};

		this.getHand = function ( index ) {

			let controller = controllers[ index ];

			if ( controller === undefined ) {

				controller = new WebXRController();
				controllers[ index ] = controller;

			}

			return controller.getHandSpace();

		};

		//

		function onSessionEvent( event ) {

			const controllerIndex = controllerInputSources.indexOf( event.inputSource );

			if ( controllerIndex === - 1 ) {

				return;

			}

			const controller = controllers[ controllerIndex ];

			if ( controller !== undefined ) {

				controller.dispatchEvent( { type: event.type, data: event.inputSource } );

			}

		}

		function onSessionEnd() {

			session.removeEventListener( 'select', onSessionEvent );
			session.removeEventListener( 'selectstart', onSessionEvent );
			session.removeEventListener( 'selectend', onSessionEvent );
			session.removeEventListener( 'squeeze', onSessionEvent );
			session.removeEventListener( 'squeezestart', onSessionEvent );
			session.removeEventListener( 'squeezeend', onSessionEvent );
			session.removeEventListener( 'end', onSessionEnd );
			session.removeEventListener( 'inputsourceschange', onInputSourcesChange );

			for ( let i = 0; i < controllers.length; i ++ ) {

				const inputSource = controllerInputSources[ i ];

				if ( inputSource === null ) continue;

				controllerInputSources[ i ] = null;

				controllers[ i ].disconnect( inputSource );

			}

			_currentDepthNear = null;
			_currentDepthFar = null;

			// restore framebuffer/rendering state

			renderer.setRenderTarget( initialRenderTarget );

			glBaseLayer = null;
			glProjLayer = null;
			glBinding = null;
			session = null;
			newRenderTarget = null;

			// switch layers back to emulated
			if ( supportsLayers === true ) {

				for ( const layer of layers ) {

					layer.renderTarget = new WebGLRenderTarget( layer.pixelwidth, layer.pixelheight,
						{
							format: RGBAFormat,
							type: UnsignedByteType,
							depthTexture: new DepthTexture( layer.pixelwidth, layer.pixelheight, UnsignedInt248Type, undefined, undefined, undefined, undefined, undefined, undefined, DepthStencilFormat ),
							stencilBuffer: attributes.stencil,
							encoding: renderer.outputEncoding,
							samples: 4
						} );

					layer.plane.material = layer.material;
					layer.material.map = layer.renderTarget.texture;
					delete layer.xrlayer;

				}

			}

			//

			animation.stop();

			scope.isPresenting = false;

			scope.dispatchEvent( { type: 'sessionend' } );

		}

		this.setFramebufferScaleFactor = function ( value ) {

			framebufferScaleFactor = value;

			if ( scope.isPresenting === true ) {

				console.warn( 'THREE.WebXRManager: Cannot change framebuffer scale while presenting.' );

			}

		};

		this.setReferenceSpaceType = function ( value ) {

			referenceSpaceType = value;

			if ( scope.isPresenting === true ) {

				console.warn( 'THREE.WebXRManager: Cannot change reference space type while presenting.' );

			}

		};

		this.getReferenceSpace = function () {

			return customReferenceSpace || referenceSpace;

		};

		this.setReferenceSpace = function ( space ) {

			customReferenceSpace = space;

		};

		this.getBaseLayer = function () {

			return glProjLayer !== null ? glProjLayer : glBaseLayer;

		};

		this.getBinding = function () {

			return glBinding;

		};

		this.getFrame = function () {

			return xrFrame;

		};

		this.getSession = function () {

			return session;

		};

		this.setSession = async function ( value ) {

			session = value;

			if ( session !== null ) {

				initialRenderTarget = renderer.getRenderTarget();

				session.addEventListener( 'select', onSessionEvent );
				session.addEventListener( 'selectstart', onSessionEvent );
				session.addEventListener( 'selectend', onSessionEvent );
				session.addEventListener( 'squeeze', onSessionEvent );
				session.addEventListener( 'squeezestart', onSessionEvent );
				session.addEventListener( 'squeezeend', onSessionEvent );
				session.addEventListener( 'end', onSessionEnd );
				session.addEventListener( 'inputsourceschange', onInputSourcesChange );

				if ( attributes.xrCompatible !== true ) {

					await gl.makeXRCompatible();

				}

				customReferenceSpace = null;
				referenceSpace = await session.requestReferenceSpace( referenceSpaceType );

				if ( ( session.renderState.layers === undefined ) || ( renderer.capabilities.isWebGL2 === false ) ) {

					const layerInit = {
						antialias: ( session.renderState.layers === undefined ) ? attributes.antialias : true,
						alpha: attributes.alpha,
						depth: attributes.depth,
						stencil: attributes.stencil,
						framebufferScaleFactor: framebufferScaleFactor
					};

					glBaseLayer = new XRWebGLLayer( session, gl, layerInit );

					session.updateRenderState( { baseLayer: glBaseLayer } );

					newRenderTarget = new WebGLRenderTarget(
						glBaseLayer.framebufferWidth,
						glBaseLayer.framebufferHeight,
						{
							format: RGBAFormat,
							type: UnsignedByteType,
							encoding: renderer.outputEncoding,
							stencilBuffer: attributes.stencil
						}
					);

				} else {

					supportsLayers = true;
					let depthFormat = null;
					let depthType = null;
					let glDepthFormat = null;

					if ( attributes.depth ) {

						glDepthFormat = attributes.stencil ? gl.DEPTH24_STENCIL8 : gl.DEPTH_COMPONENT24;
						depthFormat = attributes.stencil ? DepthStencilFormat : DepthFormat;
						depthType = attributes.stencil ? UnsignedInt248Type : UnsignedIntType;

					}

					const projectionlayerInit = {
						colorFormat: gl.RGBA8,
						depthFormat: glDepthFormat,
						scaleFactor: framebufferScaleFactor
					};

					glBinding = new XRWebGLBinding( session, gl );

					glProjLayer = glBinding.createProjectionLayer( projectionlayerInit );
					const layersArray = [ glProjLayer ];

					newRenderTarget = new WebGLRenderTarget(
						glProjLayer.textureWidth,
						glProjLayer.textureHeight,
						{
							format: RGBAFormat,
							type: UnsignedByteType,
							depthTexture: new DepthTexture( glProjLayer.textureWidth, glProjLayer.textureHeight, depthType, undefined, undefined, undefined, undefined, undefined, undefined, depthFormat ),
							stencilBuffer: attributes.stencil,
							encoding: renderer.outputEncoding,
							samples: attributes.antialias ? 4 : 0
						} );

					const renderTargetProperties = renderer.properties.get( newRenderTarget );
					renderTargetProperties.__ignoreDepthValues = glProjLayer.ignoreDepthValues;

					// switch layers to native
					for ( const layer of layers ) {

						layer.plane.material = new MeshBasicMaterial( { color: 0xffffff, side: layer.type === 'cylinder' ? BackSide : FrontSide } );
						layer.plane.material.blending = CustomBlending;
						layer.plane.material.blendEquation = AddEquation;
						layer.plane.material.blendSrc = ZeroFactor;
						layer.plane.material.blendDst = ZeroFactor;

						if ( layer.type === 'quad' ) {

							layer.xrlayer = glBinding.createQuadLayer( {
								transform: new XRRigidTransform( layer.translation, layer.quaternion ),
								width: layer.width / 2,
								height: layer.height / 2,
								space: referenceSpace,
								viewPixelWidth: layer.pixelwidth,
								viewPixelHeight: layer.pixelheight
							} );

						} else {

							layer.xrlayer = glBinding.createCylinderLayer( {
								transform: new XRRigidTransform( layer.translation, layer.quaternion ),
								radius: layer.radius,
								centralAngle: layer.centralAngle,
								aspectRatio: layer.aspectRatio,
								space: referenceSpace,
								viewPixelWidth: layer.pixelwidth,
								viewPixelHeight: layer.pixelheight
							} );

						}

						layersArray.unshift( layer.xrlayer );

					}

					session.updateRenderState( { layers: layersArray } );

				}

				newRenderTarget.isXRRenderTarget = true; // TODO Remove this when possible, see #23278

				// Set foveation to maximum.
				this.setFoveation( 1.0 );

				animation.setContext( session );
				animation.start();

				scope.isPresenting = true;

				scope.dispatchEvent( { type: 'sessionstart' } );

			}

		};

		function onInputSourcesChange( event ) {

			// Notify disconnected

			for ( let i = 0; i < event.removed.length; i ++ ) {

				const inputSource = event.removed[ i ];
				const index = controllerInputSources.indexOf( inputSource );

				if ( index >= 0 ) {

					controllerInputSources[ index ] = null;
					controllers[ index ].disconnect( inputSource );

				}

			}

			// Notify connected

			for ( let i = 0; i < event.added.length; i ++ ) {

				const inputSource = event.added[ i ];

				let controllerIndex = controllerInputSources.indexOf( inputSource );

				if ( controllerIndex === - 1 ) {

					// Assign input source a controller that currently has no input source

					for ( let i = 0; i < controllers.length; i ++ ) {

						if ( i >= controllerInputSources.length ) {

							controllerInputSources.push( inputSource );
							controllerIndex = i;
							break;

						} else if ( controllerInputSources[ i ] === null ) {

							controllerInputSources[ i ] = inputSource;
							controllerIndex = i;
							break;

						}

					}

					// If all controllers do currently receive input we ignore new ones

					if ( controllerIndex === - 1 ) break;

				}

				const controller = controllers[ controllerIndex ];

				if ( controller ) {

					controller.connect( inputSource );

				}

			}

		}

		//

		const cameraLPos = new Vector3();
		const cameraRPos = new Vector3();

		/**
		 * Assumes 2 cameras that are parallel and share an X-axis, and that
		 * the cameras' projection and world matrices have already been set.
		 * And that near and far planes are identical for both cameras.
		 * Visualization of this technique: https://computergraphics.stackexchange.com/a/4765
		 */
		function setProjectionFromUnion( camera, cameraL, cameraR ) {

			cameraLPos.setFromMatrixPosition( cameraL.matrixWorld );
			cameraRPos.setFromMatrixPosition( cameraR.matrixWorld );

			const ipd = cameraLPos.distanceTo( cameraRPos );

			const projL = cameraL.projectionMatrix.elements;
			const projR = cameraR.projectionMatrix.elements;

			// VR systems will have identical far and near planes, and
			// most likely identical top and bottom frustum extents.
			// Use the left camera for these values.
			const near = projL[ 14 ] / ( projL[ 10 ] - 1 );
			const far = projL[ 14 ] / ( projL[ 10 ] + 1 );
			const topFov = ( projL[ 9 ] + 1 ) / projL[ 5 ];
			const bottomFov = ( projL[ 9 ] - 1 ) / projL[ 5 ];

			const leftFov = ( projL[ 8 ] - 1 ) / projL[ 0 ];
			const rightFov = ( projR[ 8 ] + 1 ) / projR[ 0 ];
			const left = near * leftFov;
			const right = near * rightFov;

			// Calculate the new camera's position offset from the
			// left camera. xOffset should be roughly half `ipd`.
			const zOffset = ipd / ( - leftFov + rightFov );
			const xOffset = zOffset * - leftFov;

			// TODO: Better way to apply this offset?
			cameraL.matrixWorld.decompose( camera.position, camera.quaternion, camera.scale );
			camera.translateX( xOffset );
			camera.translateZ( zOffset );
			camera.matrixWorld.compose( camera.position, camera.quaternion, camera.scale );
			camera.matrixWorldInverse.copy( camera.matrixWorld ).invert();

			// Find the union of the frustum values of the cameras and scale
			// the values so that the near plane's position does not change in world space,
			// although must now be relative to the new union camera.
			const near2 = near + zOffset;
			const far2 = far + zOffset;
			const left2 = left - xOffset;
			const right2 = right + ( ipd - xOffset );
			const top2 = topFov * far / far2 * near2;
			const bottom2 = bottomFov * far / far2 * near2;

			camera.projectionMatrix.makePerspective( left2, right2, top2, bottom2, near2, far2 );

		}

		function updateCamera( camera, parent ) {

			if ( parent === null ) {

				camera.matrixWorld.copy( camera.matrix );

			} else {

				camera.matrixWorld.multiplyMatrices( parent.matrixWorld, camera.matrix );

			}

			camera.matrixWorldInverse.copy( camera.matrixWorld ).invert();

		}

		this.updateCamera = function ( camera ) {

			if ( session === null ) return;

			cameraVR.near = cameraR.near = cameraL.near = camera.near;
			cameraVR.far = cameraR.far = cameraL.far = camera.far;

			if ( _currentDepthNear !== cameraVR.near || _currentDepthFar !== cameraVR.far ) {

				// Note that the new renderState won't apply until the next frame. See #18320

				session.updateRenderState( {
					depthNear: cameraVR.near,
					depthFar: cameraVR.far
				} );

				_currentDepthNear = cameraVR.near;
				_currentDepthFar = cameraVR.far;

			}

			const parent = camera.parent;
			const cameras = cameraVR.cameras;

			updateCamera( cameraVR, parent );

			for ( let i = 0; i < cameras.length; i ++ ) {

				updateCamera( cameras[ i ], parent );

			}

			cameraVR.matrixWorld.decompose( cameraVR.position, cameraVR.quaternion, cameraVR.scale );

			// update user camera and its children

			camera.matrix.copy( cameraVR.matrix );
			camera.matrix.decompose( camera.position, camera.quaternion, camera.scale );

			const children = camera.children;

			for ( let i = 0, l = children.length; i < l; i ++ ) {

				children[ i ].updateMatrixWorld( true );

			}

			// update projection matrix for proper view frustum culling

			if ( cameras.length === 2 ) {

				setProjectionFromUnion( cameraVR, cameraL, cameraR );

			} else {

				// assume single camera setup (AR)

				cameraVR.projectionMatrix.copy( cameraL.projectionMatrix );

			}

		};

		this.getCamera = function () {

			return cameraVR;

		};

		this.getFoveation = function () {

			if ( glProjLayer !== null ) {

				return glProjLayer.fixedFoveation;

			}

			if ( glBaseLayer !== null ) {

				return glBaseLayer.fixedFoveation;

			}

			return undefined;

		};

		this.setFoveation = function ( foveation ) {

			// 0 = no foveation = full resolution
			// 1 = maximum foveation = the edges render at lower resolution

			if ( glProjLayer !== null ) {

				glProjLayer.fixedFoveation = foveation;

			}

			if ( glBaseLayer !== null && glBaseLayer.fixedFoveation !== undefined ) {

				glBaseLayer.fixedFoveation = foveation;

			}

		};

		this.getPlanes = function () {

			return planes;

		};

		this.setMainScene = function ( newMainScene ) {

			mainScene = newMainScene;

		};

		this.hasXRLayers = function () {

			return mainScene !== null;

		};

		const _translationObject = new Vector3();
		const _quaternionObject = new Quaternion();

		this.createQuadLayer = function ( width, height, translation, quaternion, pixelwidth, pixelheight, rendercall ) {

			const geometry = new PlaneGeometry( width, height );
			const renderTarget = new WebGLRenderTarget( pixelwidth, pixelheight,
				{
					format: RGBAFormat,
					type: UnsignedByteType,
					depthTexture: new DepthTexture(
						pixelwidth,
						pixelheight,
						attributes.stencil ? UnsignedInt248Type : UnsignedIntType,
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
						attributes.stencil ? DepthStencilFormat : DepthFormat
					),
					stencilBuffer: attributes.stencil,
					encoding: renderer.outputEncoding,
					samples: attributes.antialias ? 4 : 1
				} );

			const material = new MeshBasicMaterial( { color: 0xffffff, side: FrontSide } );
			material.map = renderTarget.texture;
			const plane = new Mesh( geometry, material );
			plane.position.copy( translation );
			plane.quaternion.copy( quaternion );

			const layer = {
				type: 'quad',
				width: width,
				height: height,
				translation: translation,
				quaternion: quaternion,
				pixelwidth: pixelwidth,
				pixelheight: pixelheight,
				plane: plane,
				material: material,
				rendercall: rendercall,
				renderTarget: renderTarget };

			layers.push( layer );


			if ( session !== null ) {

				layer.plane.material = new MeshBasicMaterial( { color: 0xffffff, side: FrontSide } );
				layer.plane.material.blending = CustomBlending;
				layer.plane.material.blendEquation = AddEquation;
				layer.plane.material.blendSrc = ZeroFactor;
				layer.plane.material.blendDst = ZeroFactor;

				layer.xrlayer = glBinding.createQuadLayer( {
					transform: new XRRigidTransform( layer.translation, layer.quaternion ),
					width: layer.width / 2,
					height: layer.height / 2,
					space: referenceSpace,
					viewPixelWidth: layer.pixelwidth,
					viewPixelHeight: layer.pixelheight
				} );

				const xrlayers = session.renderState.layers;
				xrlayers.unshift( layer.xrlayer );
				session.updateRenderState( { layers: xrlayers } );

			}

			return plane;

		};

		this.createCylinderLayer = function ( radius, centralAngle, aspectratio, translation, quaternion, pixelwidth, pixelheight, rendercall ) {

			const geometry = new CylinderGeometry( radius, radius, radius * centralAngle / aspectratio, 64, 64, true, Math.PI - centralAngle / 2, centralAngle );
			const renderTarget = new WebGLRenderTarget( pixelwidth, pixelheight,
				{
					format: RGBAFormat,
					type: UnsignedByteType,
					depthTexture: new DepthTexture(
						pixelwidth,
						pixelheight,
						attributes.stencil ? UnsignedInt248Type : UnsignedIntType,
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
						attributes.stencil ? DepthStencilFormat : DepthFormat
					),
					stencilBuffer: attributes.stencil,
					encoding: renderer.outputEncoding,
					samples: attributes.antialias ? 4 : 1
				} );

			const material = new MeshBasicMaterial( { color: 0xffffff, side: BackSide } );
			material.map = renderTarget.texture;
			const plane = new Mesh( geometry, material );
			plane.position.copy( translation );
			plane.quaternion.copy( quaternion );

			const layer = {
				type: 'cylinder',
				radius: radius,
				centralAngle: centralAngle,
				aspectratio: aspectratio,
				translation: translation,
				quaternion: quaternion,
				pixelwidth: pixelwidth,
				pixelheight: pixelheight,
				plane: plane,
				material: material,
				rendercall: rendercall,
				renderTarget: renderTarget };

			layers.push( layer );

			if ( session !== null ) {

				layer.plane.material = new MeshBasicMaterial( { color: 0xffffff, side: BackSide } );
				layer.plane.material.blending = CustomBlending;
				layer.plane.material.blendEquation = AddEquation;
				layer.plane.material.blendSrc = ZeroFactor;
				layer.plane.material.blendDst = ZeroFactor;

				layer.xrlayer = glBinding.createCylinderLayer( {
					transform: new XRRigidTransform( layer.translation, layer.quaternion ),
					radius: layer.radius,
					centralAngle: layer.centralAngle,
					aspectRatio: layer.aspectRatio,
					space: referenceSpace,
					viewPixelWidth: layer.pixelwidth,
					viewPixelHeight: layer.pixelheight
				} );

				const xrlayers = session.renderState.layers;
				xrlayers.unshift( layer.xrlayer );
				session.updateRenderState( { layers: xrlayers } );

			}

			return plane;

		};

		// Animation Loop

		let onAnimationFrameCallback = null;

		this.on2DAnimationFrame = function ( time, frame ) {

			if ( onAnimationFrameCallback ) onAnimationFrameCallback( time, frame );

			for ( const layer of layers ) {

				renderer.setRenderTarget( layer.renderTarget );
				layer.rendercall();

			}

			renderer.setRenderTarget( null );

		};

		function isInMainScene( object ) {

			if ( object == undefined ) {

				return false;

			}

			if ( object == mainScene ) {

				return true;

			}

			return isInMainScene( object.parent );

		}

		function onAnimationFrame( time, frame ) {

			scope.drawingLayer = true;

			if ( supportsLayers === true ) {

				for ( const layer of layers ) {

					if ( layer.plane.visible && isInMainScene( layer.plane ) ) {


						layer.xrlayer.transform = new XRRigidTransform( layer.plane.getWorldPosition( _translationObject ), layer.plane.getWorldQuaternion( _quaternionObject ) );

						const glSubImage = glBinding.getSubImage( layer.xrlayer, frame );
						renderer.setRenderTargetTextures(
							layer.renderTarget,
							glSubImage.colorTexture,
							undefined );

						renderer.setRenderTarget( layer.renderTarget );
						layer.rendercall();
						renderer.setRenderTarget( null );

					}

				}

			} else {

				for ( const layer of layers ) {

					renderer.setRenderTarget( layer.renderTarget );
					layer.rendercall();

				}

				renderer.setRenderTarget( null );

			}

			scope.drawingLayer = false;

			pose = frame.getViewerPose( customReferenceSpace || referenceSpace );
			xrFrame = frame;

			if ( pose !== null ) {

				const views = pose.views;

				if ( glBaseLayer !== null ) {

					renderer.setRenderTargetFramebuffer( newRenderTarget, glBaseLayer.framebuffer );
					renderer.setRenderTarget( newRenderTarget );

				}

				let cameraVRNeedsUpdate = false;

				// check if it's necessary to rebuild cameraVR's camera list

				if ( views.length !== cameraVR.cameras.length ) {

					cameraVR.cameras.length = 0;
					cameraVRNeedsUpdate = true;

				}

				for ( let i = 0; i < views.length; i ++ ) {

					const view = views[ i ];

					let viewport = null;

					if ( glBaseLayer !== null ) {

						viewport = glBaseLayer.getViewport( view );

					} else {

						const glSubImage = glBinding.getViewSubImage( glProjLayer, view );
						viewport = glSubImage.viewport;

						// For side-by-side projection, we only produce a single texture for both eyes.
						if ( i === 0 ) {

							renderer.setRenderTargetTextures(
								newRenderTarget,
								glSubImage.colorTexture,
								glProjLayer.ignoreDepthValues ? undefined : glSubImage.depthStencilTexture );

							renderer.setRenderTarget( newRenderTarget );

						}

					}

					let camera = cameras[ i ];

					if ( camera === undefined ) {

						camera = new PerspectiveCamera();
						camera.layers.enable( i );
						camera.viewport = new Vector4();
						cameras[ i ] = camera;

					}

					camera.matrix.fromArray( view.transform.matrix );
					camera.projectionMatrix.fromArray( view.projectionMatrix );
					camera.viewport.set( viewport.x, viewport.y, viewport.width, viewport.height );

					if ( i === 0 ) {

						cameraVR.matrix.copy( camera.matrix );

					}

					if ( cameraVRNeedsUpdate === true ) {

						cameraVR.cameras.push( camera );

					}

				}

			}

			//

			for ( let i = 0; i < controllers.length; i ++ ) {

				const inputSource = controllerInputSources[ i ];
				const controller = controllers[ i ];

				if ( inputSource !== null && controller !== undefined ) {

					controller.update( inputSource, frame, customReferenceSpace || referenceSpace );

				}

			}

			if ( onAnimationFrameCallback ) onAnimationFrameCallback( time, frame );

			if ( frame.detectedPlanes ) {

				scope.dispatchEvent( { type: 'planesdetected', data: frame.detectedPlanes } );

				let planesToRemove = null;

				for ( const plane of planes ) {

					if ( ! frame.detectedPlanes.has( plane ) ) {

						if ( planesToRemove === null ) {

							planesToRemove = [];

						}

						planesToRemove.push( plane );

					}

				}

				if ( planesToRemove !== null ) {

					for ( const plane of planesToRemove ) {

						planes.delete( plane );
						planesLastChangedTimes.delete( plane );
						scope.dispatchEvent( { type: 'planeremoved', data: plane } );

					}

				}

				for ( const plane of frame.detectedPlanes ) {

					if ( ! planes.has( plane ) ) {

						planes.add( plane );
						planesLastChangedTimes.set( plane, frame.lastChangedTime );
						scope.dispatchEvent( { type: 'planeadded', data: plane } );

					} else {

						const lastKnownTime = planesLastChangedTimes.get( plane );

						if ( plane.lastChangedTime > lastKnownTime ) {

							planesLastChangedTimes.set( plane, plane.lastChangedTime );
							scope.dispatchEvent( { type: 'planechanged', data: plane } );

						}

					}

				}

			}

			xrFrame = null;

		}

		const animation = new WebGLAnimation();

		animation.setAnimationLoop( onAnimationFrame );

		this.setAnimationLoop = function ( callback ) {

			onAnimationFrameCallback = callback;

		};

		this.dispose = function () {};

	}

}

export { WebXRManager };
