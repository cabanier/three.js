import {
	BufferGeometry,
	Float32BufferAttribute,
	IndirectStorageBufferAttribute,
	Matrix4,
	Mesh,
	NodeMaterial,
	StorageBufferAttribute,
	Vector3
} from 'three/webgpu';
import {
	Discard,
	Fn,
	If,
	Loop,
	atomicAdd,
	atomicLoad,
	atomicStore,
	attribute,
	cameraProjectionMatrix,
	cameraViewMatrix,
	instanceIndex,
	modelWorldMatrix,
	screenSize,
	storage,
	struct,
	uint,
	uniform,
	varyingProperty,
	vec2,
	vec3,
	vec4
} from 'three/tsl';

const _modelViewMatrix = /*@__PURE__*/ new Matrix4();
const _cameraPosition = /*@__PURE__*/ new Vector3();
const _cameraDirection = /*@__PURE__*/ new Vector3();
const _viewCenter = /*@__PURE__*/ new Vector3();

const BIN_COUNT = 4096;
const WORKGROUP_SIZE = 256;
const SORT_DIRECTION_THRESHOLD = 0.9995;
const SORT_POSITION_THRESHOLD = 0.0025;
const KERNEL_2D_SIZE = 0.3;
const MAX_SCREEN_SPACE_SPLAT_SIZE = 1024;
const SPLAT_RADIUS = 3;

function getCount( data ) {

	if ( data.positions === undefined || data.positions.length % 3 !== 0 ) {

		throw new Error( 'GaussianSplatMesh: positions must contain three values per splat.' );

	}

	const count = data.positions.length / 3;

	if ( count === 0 ) {

		throw new Error( 'GaussianSplatMesh: At least one splat is required.' );

	}

	return count;

}

function getAttributeArray( source, count, itemSize, defaults ) {

	if ( source !== undefined && source.length !== count * itemSize ) {

		throw new Error( `GaussianSplatMesh: Expected ${ count * itemSize } attribute values but received ${ source.length }.` );

	}

	if ( source instanceof Float32Array ) return source;

	const target = new Float32Array( count * itemSize );

	for ( let i = 0; i < count; i ++ ) {

		const sourceOffset = i * itemSize;
		const targetOffset = i * itemSize;

		for ( let j = 0; j < itemSize; j ++ ) {

			target[ targetOffset + j ] = source !== undefined ? source[ sourceOffset + j ] : defaults[ j ];

		}

	}

	return target;

}

function getBoundingSphere( positions, count ) {

	const min = new Vector3( Infinity, Infinity, Infinity );
	const max = new Vector3( - Infinity, - Infinity, - Infinity );
	const center = new Vector3();
	let radiusSq = 0;

	for ( let i = 0; i < count; i ++ ) {

		const offset = i * 3;
		const x = positions[ offset ];
		const y = positions[ offset + 1 ];
		const z = positions[ offset + 2 ];

		min.x = Math.min( min.x, x );
		min.y = Math.min( min.y, y );
		min.z = Math.min( min.z, z );
		max.x = Math.max( max.x, x );
		max.y = Math.max( max.y, y );
		max.z = Math.max( max.z, z );

	}

	center.addVectors( min, max ).multiplyScalar( 0.5 );

	for ( let i = 0; i < count; i ++ ) {

		const offset = i * 3;
		const x = positions[ offset ] - center.x;
		const y = positions[ offset + 1 ] - center.y;
		const z = positions[ offset + 2 ] - center.z;

		radiusSq = Math.max( radiusSq, x * x + y * y + z * z );

	}

	return { center, radius: Math.sqrt( radiusSq ) };

}

function getSplatBudget( value, count ) {

	if ( value === Infinity ) return count;

	if ( Number.isFinite( value ) === false || value < 1 ) {

		throw new Error( 'GaussianSplatMesh: xrSplatCount must be a positive number.' );

	}

	return Math.min( count, Math.floor( value ) );

}

/**
 * A WebGPU implementation of 3D Gaussian splatting.
 *
 * Splats are culled, compacted and depth sorted on the GPU. Rendering uses an
 * indirect draw so the visible instance count never has to be read by the CPU.
 *
 * Call {@link GaussianSplatMesh#update} before rendering whenever the camera or
 * the object transform changes.
 *
 * @augments Mesh
 * @three_import import { GaussianSplatMesh } from 'three/addons/objects/GaussianSplatMesh.js';
 */
class GaussianSplatMesh extends Mesh {

	/**
	 * Constructs a new Gaussian splat mesh.
	 *
	 * @param {WebGPURenderer} renderer - The WebGPU renderer used to execute the compute passes.
	 * @param {Object} data - The splat data.
	 * @param {ArrayLike<number>} data.positions - Splat centers stored as XYZ values.
	 * @param {ArrayLike<number>} [data.scales] - Gaussian standard deviations stored as XYZ values.
	 * @param {ArrayLike<number>} [data.rotations] - Unit quaternions stored as XYZW values.
	 * @param {ArrayLike<number>} [data.colors] - Linear RGBA colors.
	 * @param {Object} [options={}] - Rendering options.
	 * @param {number} [options.xrSplatCount] - The maximum number of visible splats rendered in XR.
	 * @param {boolean} [options.releaseCPUData=false] - Whether to release CPU-side storage after the first render.
	 */
	constructor( renderer, data, options = {} ) {

		if ( renderer.backend.isWebGPUBackend !== true ) {

			throw new Error( 'GaussianSplatMesh: WebGPU is required.' );

		}

		const count = getCount( data );
		const boundingSphere = getBoundingSphere( data.positions, count );

		const positions = getAttributeArray( data.positions, count, 3, [ 0, 0, 0 ] );
		const scales = getAttributeArray( data.scales, count, 3, [ 0.05, 0.05, 0.05 ] );
		const rotations = getAttributeArray( data.rotations, count, 4, [ 0, 0, 0, 1 ] );
		const colors = getAttributeArray( data.colors, count, 4, [ 1, 1, 1, 1 ] );

		const positionAttribute = new StorageBufferAttribute( positions, 3 );
		const scaleAttribute = new StorageBufferAttribute( scales, 3 );
		const rotationAttribute = new StorageBufferAttribute( rotations, 4 );
		const colorAttribute = new StorageBufferAttribute( colors, 4 );
		const binAttribute = new StorageBufferAttribute( new Uint32Array( count ), 1 );
		const orderAttribute = new StorageBufferAttribute( new Uint32Array( count ), 1 );
		const histogramAttribute = new StorageBufferAttribute( new Uint32Array( BIN_COUNT ), 1 );
		const offsetAttribute = new StorageBufferAttribute( new Uint32Array( BIN_COUNT ), 1 );
		const storageAttributes = [
			positionAttribute,
			scaleAttribute,
			rotationAttribute,
			colorAttribute,
			binAttribute,
			orderAttribute,
			histogramAttribute,
			offsetAttribute
		];

		const positionStorage = storage( positionAttribute, 'vec3', count ).setName( 'GaussianSplatPositions' );
		const scaleStorage = storage( scaleAttribute, 'vec3', count ).setName( 'GaussianSplatScales' );
		const rotationStorage = storage( rotationAttribute, 'vec4', count ).setName( 'GaussianSplatRotations' );
		const colorStorage = storage( colorAttribute, 'vec4', count ).setName( 'GaussianSplatColors' );
		const binStorage = storage( binAttribute, 'uint', count ).setName( 'GaussianSplatBins' );
		const orderStorage = storage( orderAttribute, 'uint', count ).setName( 'GaussianSplatOrder' );
		const histogramStorage = storage( histogramAttribute, 'uint', BIN_COUNT ).setName( 'GaussianSplatHistogram' ).toAtomic();
		const offsetStorage = storage( offsetAttribute, 'uint', BIN_COUNT ).setName( 'GaussianSplatOffsets' ).toAtomic();

		const positionRead = positionStorage.toReadOnly();
		const scaleRead = scaleStorage.toReadOnly();
		const rotationRead = rotationStorage.toReadOnly();
		const colorRead = colorStorage.toReadOnly();
		const binRead = storage( binAttribute, 'uint', count ).setName( 'GaussianSplatBins' ).toReadOnly();
		const orderRead = storage( orderAttribute, 'uint', count ).setName( 'GaussianSplatOrder' ).toReadOnly();

		const geometry = new BufferGeometry();
		geometry.setAttribute( 'position', new Float32BufferAttribute( [
			- 1, - 1, 0, 1, - 1, 0, 1, 1, 0,
			- 1, - 1, 0, 1, 1, 0, - 1, 1, 0
		], 3 ) );

		const drawAttribute = new IndirectStorageBufferAttribute( new Uint32Array( [ 6, 0, 0, 0 ] ), 4 );
		geometry.setIndirect( drawAttribute );

		const splatScaleNode = uniform( 1 ).setName( 'GaussianSplatScale' );
		const opacityNode = uniform( 1 ).setName( 'GaussianSplatOpacity' );
		const gaussianCoord = varyingProperty( 'vec2', 'vGaussianCoord' );
		const splatColor = varyingProperty( 'vec4', 'vGaussianColor' );

		const material = new NodeMaterial();
		material.transparent = true;
		material.depthWrite = false;
		material.fog = false;
		material.lights = false;

		material.vertexNode = Fn( () => {

			const splatIndex = orderRead.element( instanceIndex );
			const center = positionRead.element( splatIndex ).xyz;
			const scale = scaleRead.element( splatIndex ).xyz.mul( splatScaleNode );
			const quaternion = rotationRead.element( splatIndex ).normalize();

			const x = quaternion.x;
			const y = quaternion.y;
			const z = quaternion.z;
			const w = quaternion.w;

			const axisX = vec3(
				y.mul( y ).add( z.mul( z ) ).mul( - 2 ).add( 1 ),
				x.mul( y ).add( z.mul( w ) ).mul( 2 ),
				x.mul( z ).sub( y.mul( w ) ).mul( 2 )
			).mul( scale.x );
			const axisY = vec3(
				x.mul( y ).sub( z.mul( w ) ).mul( 2 ),
				x.mul( x ).add( z.mul( z ) ).mul( - 2 ).add( 1 ),
				y.mul( z ).add( x.mul( w ) ).mul( 2 )
			).mul( scale.y );
			const axisZ = vec3(
				x.mul( z ).add( y.mul( w ) ).mul( 2 ),
				y.mul( z ).sub( x.mul( w ) ).mul( 2 ),
				x.mul( x ).add( y.mul( y ) ).mul( - 2 ).add( 1 )
			).mul( scale.z );

			const centerWorld = modelWorldMatrix.mul( vec4( center, 1 ) );
			const centerView = cameraViewMatrix.mul( centerWorld );
			const centerClip = cameraProjectionMatrix.mul( centerView ).toVar();

			const axisViewX = cameraViewMatrix.mul( modelWorldMatrix.mul( vec4( axisX, 0 ) ) ).xyz;
			const axisViewY = cameraViewMatrix.mul( modelWorldMatrix.mul( vec4( axisY, 0 ) ) ).xyz;
			const axisViewZ = cameraViewMatrix.mul( modelWorldMatrix.mul( vec4( axisZ, 0 ) ) ).xyz;
			const inverseDepth = centerView.z.negate().reciprocal();
			const inverseDepthSquared = inverseDepth.mul( inverseDepth );
			const focalX = cameraProjectionMatrix.element( 0 ).element( 0 );
			const focalY = cameraProjectionMatrix.element( 1 ).element( 1 );

			const projectAxis = ( axis ) => vec2(
				axis.x.mul( inverseDepth ).add( centerView.x.mul( axis.z ).mul( inverseDepthSquared ) ).mul( focalX ),
				axis.y.mul( inverseDepth ).add( centerView.y.mul( axis.z ).mul( inverseDepthSquared ) ).mul( focalY )
			).mul( screenSize ).mul( 0.5 );

			const projectedX = projectAxis( axisViewX );
			const projectedY = projectAxis( axisViewY );
			const projectedZ = projectAxis( axisViewZ );
			const covarianceBaseX = projectedX.x.pow2().add( projectedY.x.pow2() ).add( projectedZ.x.pow2() );
			const covarianceY = projectedX.x.mul( projectedX.y ).add( projectedY.x.mul( projectedY.y ) ).add( projectedZ.x.mul( projectedZ.y ) );
			const covarianceBaseZ = projectedX.y.pow2().add( projectedY.y.pow2() ).add( projectedZ.y.pow2() );
			const covarianceX = covarianceBaseX.add( KERNEL_2D_SIZE );
			const covarianceZ = covarianceBaseZ.add( KERNEL_2D_SIZE );
			const determinantBase = covarianceBaseX.mul( covarianceBaseZ ).sub( covarianceY.pow2() );
			const determinant = covarianceX.mul( covarianceZ ).sub( covarianceY.pow2() );
			const alphaScale = determinantBase.div( determinant.max( 1e-6 ) ).max( 0 ).sqrt();

			const trace = covarianceX.add( covarianceZ ).mul( 0.5 );
			const radius = covarianceX.sub( covarianceZ ).mul( 0.5 ).pow2().add( covarianceY.pow2() ).sqrt();
			const eigenvalue1 = trace.add( radius ).max( 1e-6 );
			const eigenvalue2 = trace.sub( radius ).max( 1e-6 );
			const eigenvector = vec2( 1, 0 ).toVar();

			If( covarianceY.abs().greaterThan( 1e-6 ), () => {

				eigenvector.assign( vec2( covarianceY, eigenvalue1.sub( covarianceX ) ).normalize() );

			} ).ElseIf( covarianceZ.greaterThan( covarianceX ), () => {

				eigenvector.assign( vec2( 0, 1 ) );

			} );

			const perpendicular = vec2( eigenvector.y.negate(), eigenvector.x );
			const corner = attribute( 'position' ).xy;
			const scale1 = eigenvalue1.sqrt().mul( SPLAT_RADIUS ).min( MAX_SCREEN_SPACE_SPLAT_SIZE );
			const scale2 = eigenvalue2.sqrt().mul( SPLAT_RADIUS ).min( MAX_SCREEN_SPACE_SPLAT_SIZE );
			const offset = eigenvector.mul( scale1 ).mul( corner.x )
				.add( perpendicular.mul( scale2 ).mul( corner.y ) );

			centerClip.xy.addAssign( offset.mul( 2 ).div( screenSize ).mul( centerClip.w ) );
			gaussianCoord.assign( corner.mul( SPLAT_RADIUS ) );

			const color = colorRead.element( splatIndex );
			splatColor.assign( vec4( color.rgb, color.a.mul( alphaScale ) ) );

			return centerClip;

		} )();

		material.colorNode = splatColor.rgb;
		material.opacityNode = Fn( () => {

			const radiusSquared = gaussianCoord.dot( gaussianCoord );

			If( radiusSquared.greaterThan( 9 ), () => {

				Discard();

			} );

			const alpha = radiusSquared.mul( - 0.5 ).exp().mul( splatColor.a ).mul( opacityNode );

			If( alpha.lessThan( 1 / 255 ), () => {

				Discard();

			} );

			return alpha;

		} )();

		super( geometry, material );

		this.isGaussianSplatMesh = true;
		this.count = count;
		this.frustumCulled = false;
		this._renderer = renderer;
		this._splatScaleNode = splatScaleNode;
		this._opacityNode = opacityNode;
		this._boundingCenter = boundingSphere.center;
		this._boundingRadius = boundingSphere.radius;
		this._matrixWorld = new Matrix4();
		this._modelViewMatrix = new Matrix4();
		this._projectionMatrix = new Matrix4();
		this._lastSortPosition = new Vector3( Infinity, Infinity, Infinity );
		this._lastSortDirection = new Vector3( 0, 0, - 1 );
		this._near = 0;
		this._far = 0;
		this._activeSplatCount = 0;
		this._xrSplatCount = getSplatBudget( options.xrSplatCount !== undefined ? options.xrSplatCount : count, count );
		this._needsUpdate = true;
		this._hasComputed = false;
		this._storageAttributes = options.releaseCPUData === true ? storageAttributes : null;

		const computeModelViewNode = uniform( this._modelViewMatrix ).setName( 'GaussianSplatModelViewMatrix' );
		const computeProjectionNode = uniform( this._projectionMatrix ).setName( 'GaussianSplatProjectionMatrix' );
		const computeNearNode = uniform( 0 ).setName( 'GaussianSplatCameraNear' );
		const computeFarNode = uniform( 0 ).setName( 'GaussianSplatCameraFar' );
		const sortNearNode = uniform( 0 ).setName( 'GaussianSplatSortNear' );
		const sortFarNode = uniform( 1 ).setName( 'GaussianSplatSortFar' );
		const activeSplatCountNode = uniform( count, 'uint' ).setName( 'GaussianSplatActiveCount' );

		this._computeNearNode = computeNearNode;
		this._computeFarNode = computeFarNode;
		this._sortNearNode = sortNearNode;
		this._sortFarNode = sortFarNode;

		const DrawCommand = struct( {
			vertexCount: 'uint',
			instanceCount: { type: 'uint', atomic: true },
			firstVertex: 'uint',
			firstInstance: 'uint'
		}, 'GaussianSplatDrawCommand' );
		const drawStorage = storage( drawAttribute, DrawCommand, 1 ).setName( 'GaussianSplatDrawBuffer' );

		this._reset = Fn( () => {

			atomicStore( histogramStorage.element( instanceIndex ), uint( 0 ) );

			If( instanceIndex.equal( uint( 0 ) ), () => {

				drawStorage.get( 'vertexCount' ).assign( 6 );
				atomicStore( drawStorage.get( 'instanceCount' ), uint( 0 ) );
				drawStorage.get( 'firstVertex' ).assign( 0 );
				drawStorage.get( 'firstInstance' ).assign( 0 );

			} );

		} )().compute( BIN_COUNT, [ WORKGROUP_SIZE ] ).setName( 'Gaussian Splat Reset' );

		const getSplatIndex = () => {

			const splatIndex = instanceIndex.toVar();

			If( activeSplatCountNode.lessThan( uint( count ) ), () => {

				splatIndex.assign( instanceIndex.toFloat().add( 0.5 )
					.mul( count ).div( activeSplatCountNode.toFloat() ).floor().toUint()
					.min( uint( count - 1 ) ) );

			} );

			return splatIndex;

		};

		this._cull = Fn( () => {

			const splatIndex = getSplatIndex();
			const center = positionRead.element( splatIndex );
			const viewPosition = computeModelViewNode.mul( vec4( center.xyz, 1 ) );
			const clipPosition = computeProjectionNode.mul( viewPosition );
			const depth = viewPosition.z.negate();
			const modelScale = computeModelViewNode.element( 0 ).xyz.length()
				.max( computeModelViewNode.element( 1 ).xyz.length() )
				.max( computeModelViewNode.element( 2 ).xyz.length() );
			const radius = scaleRead.element( splatIndex ).xyz.length().mul( splatScaleNode ).mul( modelScale ).mul( 3 );
			const clipMarginX = clipPosition.w.add( radius.mul( computeProjectionNode.element( 0 ).element( 0 ).abs() ) );
			const clipMarginY = clipPosition.w.add( radius.mul( computeProjectionNode.element( 1 ).element( 1 ).abs() ) );
			const visible = depth.add( radius ).greaterThan( computeNearNode )
				.and( depth.sub( radius ).lessThan( computeFarNode ) )
				.and( clipPosition.x.abs().lessThanEqual( clipMarginX ) )
				.and( clipPosition.y.abs().lessThanEqual( clipMarginY ) )
				.and( colorRead.element( splatIndex ).a.greaterThan( 1 / 255 ) );

			binStorage.element( instanceIndex ).assign( uint( 0xffffffff ) );

			If( visible, () => {

				const normalizedDepth = depth.sub( sortNearNode ).div( sortFarNode.sub( sortNearNode ) ).clamp();
				const bin = normalizedDepth.oneMinus().mul( BIN_COUNT - 1 ).toUint();

				atomicAdd( drawStorage.get( 'instanceCount' ), uint( 1 ) );
				atomicAdd( histogramStorage.element( bin ), uint( 1 ) );
				binStorage.element( instanceIndex ).assign( bin );

			} );

		} )().compute( count, [ Math.min( WORKGROUP_SIZE, count ) ] ).setName( 'Gaussian Splat Cull' );

		this._prefix = Fn( () => {

			const sum = uint( 0 ).toVar();

			Loop( { start: uint( 0 ), end: uint( BIN_COUNT ), type: 'uint', condition: '<' }, ( { i } ) => {

				const binCount = atomicLoad( histogramStorage.element( i ) );
				atomicStore( offsetStorage.element( i ), sum );
				sum.addAssign( binCount );

			} );

		} )().compute( 1 ).setName( 'Gaussian Splat Prefix' );

		this._scatter = Fn( () => {

			const bin = binRead.element( instanceIndex );

			If( bin.lessThan( uint( BIN_COUNT ) ), () => {

				const targetIndex = atomicAdd( offsetStorage.element( bin ), uint( 1 ) );
				orderStorage.element( targetIndex ).assign( getSplatIndex() );

			} );

		} )().compute( count, [ Math.min( WORKGROUP_SIZE, count ) ] ).setName( 'Gaussian Splat Scatter' );

		this._activeSplatCountNode = activeSplatCountNode;
		this._computeNodes = [ this._reset, this._cull, this._prefix, this._scatter ];

	}

	/**
	 * Global multiplier for each Gaussian's standard deviation.
	 *
	 * @type {number}
	 */
	get splatScale() {

		return this._splatScaleNode.value;

	}

	set splatScale( value ) {

		this._splatScaleNode.value = value;
		this._needsUpdate = true;

	}

	/**
	 * Global opacity multiplier.
	 *
	 * @type {number}
	 */
	get opacity() {

		return this._opacityNode.value;

	}

	set opacity( value ) {

		this._opacityNode.value = value;

	}

	/**
	 * Maximum number of visible splats rendered when using an XR camera.
	 *
	 * @type {number}
	 */
	get xrSplatCount() {

		return this._xrSplatCount;

	}

	set xrSplatCount( value ) {

		this._xrSplatCount = getSplatBudget( value, this.count );
		this._needsUpdate = true;

	}

	/**
	 * Executes GPU culling, compaction and sorting for the current view.
	 *
	 * @param {PerspectiveCamera} camera - The camera used to render this mesh.
	 * @param {boolean} [force=false] - Whether to update even if the matrices did not change.
	 * @return {boolean} Whether the compute passes were executed.
	 */
	update( camera, force = false ) {

		if ( camera.isPerspectiveCamera !== true ) {

			throw new Error( 'GaussianSplatMesh: Only perspective cameras are supported.' );

		}

		this.updateWorldMatrix( true, false );

		// XRManager supplies an ArrayCamera with its rig transform already applied.
		if ( camera.isArrayCamera !== true ) camera.updateWorldMatrix( true, false );

		_modelViewMatrix.multiplyMatrices( camera.matrixWorldInverse, this.matrixWorld );
		_cameraPosition.setFromMatrixPosition( camera.matrixWorld );

		const cameraMatrix = camera.matrixWorld.elements;
		_cameraDirection.set( - cameraMatrix[ 8 ], - cameraMatrix[ 9 ], - cameraMatrix[ 10 ] ).normalize();

		const activeSplatCount = camera.isArrayCamera === true ? this._xrSplatCount : this.count;
		const positionChanged = _cameraPosition.distanceToSquared( this._lastSortPosition ) >
			SORT_POSITION_THRESHOLD * SORT_POSITION_THRESHOLD;
		const directionChanged = _cameraDirection.dot( this._lastSortDirection ) < SORT_DIRECTION_THRESHOLD;

		if ( force === false && this._needsUpdate === false && this._matrixWorld.equals( this.matrixWorld ) &&
			positionChanged === false && directionChanged === false &&
			this._projectionMatrix.equals( camera.projectionMatrix ) && this._near === camera.near && this._far === camera.far &&
			this._activeSplatCount === activeSplatCount ) {

			return false;

		}

		const modelViewElements = _modelViewMatrix.elements;
		const modelScale = Math.max(
			Math.hypot( modelViewElements[ 0 ], modelViewElements[ 1 ], modelViewElements[ 2 ] ),
			Math.hypot( modelViewElements[ 4 ], modelViewElements[ 5 ], modelViewElements[ 6 ] ),
			Math.hypot( modelViewElements[ 8 ], modelViewElements[ 9 ], modelViewElements[ 10 ] )
		);

		_viewCenter.copy( this._boundingCenter ).applyMatrix4( _modelViewMatrix );

		const centerDepth = - _viewCenter.z;
		const sortRadius = this._boundingRadius * modelScale;
		const sortNear = Math.max( camera.near, centerDepth - sortRadius );
		const sortFar = Math.max( sortNear + 0.0001, Math.min( camera.far, centerDepth + sortRadius ) );

		this._matrixWorld.copy( this.matrixWorld );
		this._modelViewMatrix.copy( _modelViewMatrix );
		this._projectionMatrix.copy( camera.projectionMatrix );
		this._lastSortPosition.copy( _cameraPosition );
		this._lastSortDirection.copy( _cameraDirection );
		this._near = this._computeNearNode.value = camera.near;
		this._far = this._computeFarNode.value = camera.far;
		this._sortNearNode.value = sortNear;
		this._sortFarNode.value = sortFar;
		this._activeSplatCount = activeSplatCount;
		this._activeSplatCountNode.value = activeSplatCount;
		this._cull.count = activeSplatCount;
		this._scatter.count = activeSplatCount;
		this._needsUpdate = false;

		this._renderer.compute( this._computeNodes );
		this._hasComputed = true;

		return true;

	}

	/**
	 * Marks the GPU visibility and sort data as stale.
	 */
	set needsUpdate( value ) {

		this._needsUpdate = value;

	}

	get needsUpdate() {

		return this._needsUpdate;

	}

	/**
	 * Releases CPU-side storage after all compute and render buffers have been uploaded.
	 *
	 * @private
	 */
	onAfterRender() {

		if ( this._hasComputed === false || this._storageAttributes === null ) return;

		for ( const attribute of this._storageAttributes ) attribute.array = null;

		this._storageAttributes = null;

	}

	/**
	 * Frees the geometry and material resources owned by this mesh.
	 */
	dispose() {

		for ( const computeNode of this._computeNodes ) computeNode.dispose();

		this.geometry.dispose();
		this.material.dispose();

	}

}

export { GaussianSplatMesh };
