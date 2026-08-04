import { mrt } from '../../nodes/core/MRTNode.js';
import { velocity } from '../../nodes/accessors/VelocityNode.js';
import DirectRenderPipeline from './DirectRenderPipeline.js';

/**
 * A direct render pipeline that submits motion vectors and depth when the active
 * WebGPU XR session has the `space-warp` feature enabled.
 *
 * @augments DirectRenderPipeline
 */
class XRSpaceWarpRenderPipeline extends DirectRenderPipeline {

	/**
	 * Constructs a new XR space-warp render pipeline.
	 *
	 * @param {Renderer} renderer - A reference to the renderer.
	 */
	constructor( renderer ) {

		super( renderer );

		/**
		 * This flag can be used for type testing.
		 *
		 * @type {boolean}
		 * @readonly
		 * @default true
		 */
		this.isXRSpaceWarpRenderPipeline = true;

		this._spaceWarpMRT = mrt( { velocity } );

	}

	/**
	 * Renders the color image followed by space-warp motion vectors and depth.
	 *
	 * @param {Object3D} scene - The scene or object to render.
	 * @param {Camera} camera - The camera to render with.
	 */
	render( scene, camera ) {

		super.render( scene, camera );

		const renderer = this.renderer;
		const renderTarget = renderer.xr.getSpaceWarpRenderTarget();

		if ( renderTarget === null ) return;

		const currentRenderTarget = renderer.getRenderTarget();
		const currentActiveCubeFace = renderer.getActiveCubeFace();
		const currentActiveMipmapLevel = renderer.getActiveMipmapLevel();
		const currentOutputRenderTarget = renderer.getOutputRenderTarget();
		const currentMRT = renderer.getMRT();
		const currentContextNode = renderer.contextNode;
		const currentBackground = scene.isScene === true ? scene.background : null;
		const currentBackgroundNode = scene.isScene === true ? scene.backgroundNode : null;
		const spaceWarpObjects = [];

		try {

			scene.traverseVisible( ( object ) => {

				if ( object.onBeforeXRSpaceWarpRender !== undefined ) {

					object.onBeforeXRSpaceWarpRender();
					spaceWarpObjects.push( object );

				}

			} );

			if ( scene.isScene === true ) {

				scene.background = null;
				scene.backgroundNode = null;

			}

			renderer.setOutputRenderTarget( renderTarget );
			renderer.setRenderTarget( renderTarget );
			renderer.setMRT( this._spaceWarpMRT );
			renderer.contextNode = this._contextNode;
			renderer.render( scene, camera );

		} finally {

			for ( let i = spaceWarpObjects.length - 1; i >= 0; i -- ) {

				if ( spaceWarpObjects[ i ].onAfterXRSpaceWarpRender !== undefined ) {

					spaceWarpObjects[ i ].onAfterXRSpaceWarpRender();

				}

			}

			if ( scene.isScene === true ) {

				scene.background = currentBackground;
				scene.backgroundNode = currentBackgroundNode;

			}

			renderer.contextNode = currentContextNode;
			renderer.setMRT( currentMRT );
			renderer.setOutputRenderTarget( currentOutputRenderTarget );
			renderer.setRenderTarget( currentRenderTarget, currentActiveCubeFace, currentActiveMipmapLevel );

		}

	}

}

export default XRSpaceWarpRenderPipeline;
