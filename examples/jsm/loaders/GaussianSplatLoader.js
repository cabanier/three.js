import {
	FileLoader,
	Loader
} from 'three';
import { Gunzip } from '../libs/fflate.module.js';

const ROW_LENGTH = 32;
const SPZ_HEADER_LENGTH = 16;
const SPZ_MAGIC = 0x5053474e;
const SPZ_COLOR_SCALE = 0.15;
const SH_C0 = 0.28209479177387814;
const SH_DIMENSIONS = [ 0, 3, 8, 15 ];
const MAX_SPZ_POINTS = 10000000;
const GZIP_CHUNK_SIZE = 64 * 1024;

function srgbToLinear( value ) {

	return value < 0.04045 ? value / 12.92 : Math.pow( ( value + 0.055 ) / 1.055, 2.4 );

}

function getSourceIndex( index, count, sourceCount ) {

	return count === sourceCount ? index : Math.floor( ( index + 0.5 ) * sourceCount / count );

}

function readFixed24( bytes, offset ) {

	let value = bytes[ offset ] | ( bytes[ offset + 1 ] << 8 ) | ( bytes[ offset + 2 ] << 16 );

	if ( value & 0x800000 ) value |= 0xff000000;

	return value;

}

function createSPZDecoder( maxSplats ) {

	const header = new Uint8Array( SPZ_HEADER_LENGTH );
	const record = new Uint8Array( 9 );
	// Position, alpha, color, scale and rotation record sizes.
	const recordSizes = [ 9, 1, 3, 3, 3 ];

	let data = null;
	let expectedLength = 0;
	let byteLength = 0;
	let phase = 0;
	let sourceIndex = 0;
	let targetIndex = 0;
	let recordOffset = 0;
	let positionScale = 0;

	function readHeader() {

		const view = new DataView( header.buffer );
		const magic = view.getUint32( 0, true );
		const version = view.getUint32( 4, true );
		const sourceCount = view.getUint32( 8, true );
		const shDegree = view.getUint8( 12 );
		const fractionalBits = view.getUint8( 13 );

		if ( magic !== SPZ_MAGIC ) {

			throw new Error( 'GaussianSplatLoader: Invalid SPZ magic.' );

		}

		if ( version !== 2 ) {

			throw new Error( `GaussianSplatLoader: Unsupported SPZ version ${ version }.` );

		}

		if ( sourceCount === 0 || sourceCount > MAX_SPZ_POINTS || shDegree > 3 || fractionalBits > 30 ) {

			throw new Error( 'GaussianSplatLoader: Invalid SPZ metadata.' );

		}

		const count = Math.min( sourceCount, maxSplats );
		const positions = new Float32Array( count * 3 );
		const scales = new Float32Array( count * 3 );
		const rotations = new Float32Array( count * 4 );
		const colors = new Float32Array( count * 4 );
		const shCount = sourceCount * SH_DIMENSIONS[ shDegree ] * 3;

		data = { positions, scales, rotations, colors, sourceCount };
		expectedLength = SPZ_HEADER_LENGTH + sourceCount * 19 + shCount;
		positionScale = 1 / ( 1 << fractionalBits );

	}

	function decodeRecord() {

		const { positions, scales, rotations, colors } = data;
		const vectorOffset = targetIndex * 3;
		const quaternionOffset = targetIndex * 4;

		if ( phase === 0 ) {

			for ( let i = 0; i < 3; i ++ ) {

				positions[ vectorOffset + i ] = readFixed24( record, i * 3 ) * positionScale;

			}

		} else if ( phase === 1 ) {

			colors[ quaternionOffset + 3 ] = record[ 0 ] / 255;

		} else if ( phase === 2 ) {

			for ( let i = 0; i < 3; i ++ ) {

				const color = ( record[ i ] / 255 - 0.5 ) / SPZ_COLOR_SCALE;
				colors[ quaternionOffset + i ] = Math.min( Math.max( 0.5 + SH_C0 * color, 0 ), 1 );

			}

		} else if ( phase === 3 ) {

			for ( let i = 0; i < 3; i ++ ) {

				scales[ vectorOffset + i ] = Math.exp( record[ i ] / 16 - 10 );

			}

		} else {

			const x = record[ 0 ] / 127.5 - 1;
			const y = record[ 1 ] / 127.5 - 1;
			const z = record[ 2 ] / 127.5 - 1;
			const w = Math.sqrt( Math.max( 0, 1 - x * x - y * y - z * z ) );
			const inverseLength = 1 / Math.hypot( x, y, z, w );

			rotations[ quaternionOffset ] = x * inverseLength;
			rotations[ quaternionOffset + 1 ] = y * inverseLength;
			rotations[ quaternionOffset + 2 ] = z * inverseLength;
			rotations[ quaternionOffset + 3 ] = w * inverseLength;

		}

	}

	function push( chunk ) {

		const chunkOffset = byteLength;
		byteLength += chunk.length;

		let offset = 0;

		if ( chunkOffset < SPZ_HEADER_LENGTH ) {

			const headerLength = Math.min( chunk.length, SPZ_HEADER_LENGTH - chunkOffset );
			header.set( chunk.subarray( 0, headerLength ), chunkOffset );
			offset = headerLength;

			if ( chunkOffset + headerLength === SPZ_HEADER_LENGTH ) readHeader();

		}

		if ( data === null ) return;

		const sourceCount = data.sourceCount;
		const count = data.positions.length / 3;

		while ( offset < chunk.length && phase < recordSizes.length ) {

			const selectedSourceIndex = targetIndex < count ? getSourceIndex( targetIndex, count, sourceCount ) : - 1;
			const selected = sourceIndex === selectedSourceIndex;
			const copyLength = Math.min( recordSizes[ phase ] - recordOffset, chunk.length - offset );

			if ( selected ) record.set( chunk.subarray( offset, offset + copyLength ), recordOffset );

			offset += copyLength;
			recordOffset += copyLength;

			if ( recordOffset === recordSizes[ phase ] ) {

				if ( selected ) {

					decodeRecord();
					targetIndex ++;

				}

				recordOffset = 0;
				sourceIndex ++;

				if ( sourceIndex === sourceCount ) {

					phase ++;
					sourceIndex = 0;
					targetIndex = 0;

				}

			}

		}

	}

	function finish() {

		if ( data === null || byteLength < SPZ_HEADER_LENGTH ) {

			throw new Error( 'GaussianSplatLoader: Invalid SPZ header.' );

		}

		if ( byteLength !== expectedLength || phase !== recordSizes.length ) {

			throw new Error( 'GaussianSplatLoader: Invalid SPZ buffer length.' );

		}

		return data;

	}

	return { push, finish };

}

/**
 * A loader for the binary `.splat` and compressed `.spz` formats used for 3D Gaussian splats.
 *
 * The returned position, scale, rotation and color arrays can be passed
 * directly to `GaussianSplatMesh`.
 *
 * @augments Loader
 * @three_import import { GaussianSplatLoader } from 'three/addons/loaders/GaussianSplatLoader.js';
 */
class GaussianSplatLoader extends Loader {

	constructor( manager ) {

		super( manager );

		this.maxSplats = Infinity;

	}

	/**
	 * Limits the number of splats returned by the loader. Larger assets are
	 * sampled uniformly in their original order.
	 *
	 * @param {number} maxSplats - The maximum number of splats to return.
	 * @return {GaussianSplatLoader} A reference to this loader.
	 */
	setMaxSplats( maxSplats ) {

		if ( maxSplats !== Infinity && ( Number.isFinite( maxSplats ) === false || maxSplats < 1 ) ) {

			throw new Error( 'GaussianSplatLoader: maxSplats must be a positive number.' );

		}

		this.maxSplats = Math.floor( maxSplats );

		return this;

	}

	/**
	 * Starts loading a binary splat asset.
	 *
	 * @param {string} url - The path or URL of the asset.
	 * @param {function(Object)} onLoad - Executed when loading has completed.
	 * @param {onProgressCallback} onProgress - Executed while loading is in progress.
	 * @param {onErrorCallback} onError - Executed when loading fails.
	 */
	load( url, onLoad, onProgress, onError ) {

		const scope = this;
		const loader = new FileLoader( this.manager );
		loader.setPath( this.path );
		loader.setResponseType( 'arraybuffer' );
		loader.setRequestHeader( this.requestHeader );
		loader.setWithCredentials( this.withCredentials );
		loader.load( url, function ( buffer ) {

			try {

				onLoad( scope.parse( buffer ) );

			} catch ( error ) {

				if ( onError ) {

					onError( error );

				} else {

					console.error( error );

				}

				scope.manager.itemError( url );

			}

		}, onProgress, onError );

	}

	/**
	 * Parses a binary splat asset.
	 *
	 * @param {ArrayBuffer} buffer - The binary asset data.
	 * @return {{positions:Float32Array, scales:Float32Array, rotations:Float32Array, colors:Float32Array, sourceCount:number}} The decoded splat data.
	 */
	parse( buffer ) {

		const bytes = new Uint8Array( buffer );

		if ( bytes[ 0 ] === 0x1f && bytes[ 1 ] === 0x8b ) {

			return this.parseSPZ( bytes );

		}

		return this.parseSplat( buffer );

	}

	/**
	 * Parses a binary `.splat` asset.
	 *
	 * @param {ArrayBuffer} buffer - The binary asset data.
	 * @return {{positions:Float32Array, scales:Float32Array, rotations:Float32Array, colors:Float32Array, sourceCount:number}} The decoded splat data.
	 */
	parseSplat( buffer ) {

		if ( buffer.byteLength === 0 || buffer.byteLength % ROW_LENGTH !== 0 ) {

			throw new Error( 'GaussianSplatLoader: Invalid buffer length.' );

		}

		const sourceCount = buffer.byteLength / ROW_LENGTH;
		const count = Math.min( sourceCount, this.maxSplats );
		const view = new DataView( buffer );
		const positions = new Float32Array( count * 3 );
		const scales = new Float32Array( count * 3 );
		const rotations = new Float32Array( count * 4 );
		const colors = new Float32Array( count * 4 );

		for ( let i = 0; i < count; i ++ ) {

			const sourceIndex = getSourceIndex( i, count, sourceCount );
			const rowOffset = sourceIndex * ROW_LENGTH;
			const vectorOffset = i * 3;
			const quaternionOffset = i * 4;

			positions[ vectorOffset ] = view.getFloat32( rowOffset, true );
			positions[ vectorOffset + 1 ] = view.getFloat32( rowOffset + 4, true );
			positions[ vectorOffset + 2 ] = view.getFloat32( rowOffset + 8, true );
			scales[ vectorOffset ] = view.getFloat32( rowOffset + 12, true );
			scales[ vectorOffset + 1 ] = view.getFloat32( rowOffset + 16, true );
			scales[ vectorOffset + 2 ] = view.getFloat32( rowOffset + 20, true );

			colors[ quaternionOffset ] = srgbToLinear( view.getUint8( rowOffset + 24 ) / 255 );
			colors[ quaternionOffset + 1 ] = srgbToLinear( view.getUint8( rowOffset + 25 ) / 255 );
			colors[ quaternionOffset + 2 ] = srgbToLinear( view.getUint8( rowOffset + 26 ) / 255 );
			colors[ quaternionOffset + 3 ] = view.getUint8( rowOffset + 27 ) / 255;

			const w = ( view.getUint8( rowOffset + 28 ) - 128 ) / 128;
			const x = ( view.getUint8( rowOffset + 29 ) - 128 ) / 128;
			const y = ( view.getUint8( rowOffset + 30 ) - 128 ) / 128;
			const z = ( view.getUint8( rowOffset + 31 ) - 128 ) / 128;
			const length = Math.hypot( x, y, z, w );
			const inverseLength = length > 0 ? 1 / length : 0;

			rotations[ quaternionOffset ] = length > 0 ? x * inverseLength : 0;
			rotations[ quaternionOffset + 1 ] = length > 0 ? y * inverseLength : 0;
			rotations[ quaternionOffset + 2 ] = length > 0 ? z * inverseLength : 0;
			rotations[ quaternionOffset + 3 ] = length > 0 ? w * inverseLength : 1;

		}

		return { positions, scales, rotations, colors, sourceCount };

	}

	/**
	 * Parses a gzip-compressed SPZ v2 asset.
	 *
	 * @param {Uint8Array} compressed - The compressed asset data.
	 * @return {{positions:Float32Array, scales:Float32Array, rotations:Float32Array, colors:Float32Array, sourceCount:number}} The decoded splat data.
	 */
	parseSPZ( compressed ) {

		const decoder = createSPZDecoder( this.maxSplats );
		const gunzip = new Gunzip( ( chunk ) => decoder.push( chunk ) );

		for ( let offset = 0; offset < compressed.length; offset += GZIP_CHUNK_SIZE ) {

			const end = Math.min( offset + GZIP_CHUNK_SIZE, compressed.length );
			gunzip.push( compressed.subarray( offset, end ), end === compressed.length );

		}

		return decoder.finish();

	}

}

export { GaussianSplatLoader };
