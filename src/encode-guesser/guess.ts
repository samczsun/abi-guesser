import { defaultAbiCoder, ParamType } from '@ethersproject/abi';
import { FunctionFragment } from '@ethersproject/abi/lib';
import { arrayify, BytesLike, hexlify, toUtf8String } from 'ethers/lib/utils';

// check if a given bigint can safely be represented in a number
const isSafeNumber = (val: bigint): boolean => {
    return val < BigInt(Number.MAX_SAFE_INTEGER);
};

// try and parse an offset from the data
// returns the word as a number if it's a potentially valid offset into the data
const tryParseOffset = (data: Uint8Array, pos: number): number | null => {
    const word = data.slice(pos, pos + 32);
    if (word.length === 0) return null;

    const bigOffset = BigInt(hexlify(word));

    // can't be huge
    if (!isSafeNumber(bigOffset)) return null;

    const offset = Number(bigOffset);

    // must be located in the correct region of calldata
    if (offset <= pos || offset >= data.length) return null;

    // must be a multiple of 32
    if (offset % 32 !== 0) return null;

    return offset;
};

// try and parse a length from the data
// returns the word as a number if it's a potentially valid length for the data
const tryParseLength = (data: Uint8Array, offset: number): number | null => {
    const word = data.slice(offset, offset + 32);
    if (word.length === 0) return null;

    const bigLength = BigInt(hexlify(word));

    // can't be huge
    if (!isSafeNumber(bigLength)) return null;

    const length = Number(bigLength);

    // must be valid
    if (offset + 32 + length > data.length) return null;

    return length;
};

// split a string into chunks of given length
const chunkString = (str: string, len: number): string[] => {
    const result: string[] = [];

    const size = Math.ceil(str.length / len);
    let offset = 0;

    for (let i = 0; i < size; i++) {
        result.push(str.substring(offset, offset + len));
        offset += len;
    }

    return result;
};

// count the number of leading zeros
const countLeadingZeros = (arr: Uint8Array) => {
    let count = 0;
    for (let i = 0; i < arr.length; i++) {
        if (arr[i] != 0) break;

        count++;
    }
    return count;
};

// count the number of trailing zeros
const countTrailingZeros = (arr: Uint8Array) => {
    let count = 0;
    for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i] != 0) break;

        count++;
    }
    return count;
};

// pretty print the potential param
const formatParam = (p: DecodedParam) => {
    // if (p === undefined) return 'undefined';

    if (ParamType.isParamType(p)) {
        return p.format();
    }

    return `dynamic(offset=${p.offset},len=${p.length})`;
};

const formatParams = (params: ParamType[]): string => {
    return `${params.map((v) => v.format()).join(',')}`;
};

const areParamsConsistent = (params: ParamType[]): boolean => {
    const consistencyChecker = new Set<string>();
    for (const param of params) {
        consistencyChecker.add(param.format());
    }

    return consistencyChecker.size === 1;
};

// represents a placeholder for a potential dynamic variable
type DynamicPlaceholder = {
    // the offset of the dynamic variable. always exists
    offset: number;

    // the length of the dynamic variable. only exists sometimes, like for variable length arrays
    length: number | null;
};

export type DecodedParam = ParamType | DynamicPlaceholder;

// decode a well formed tuple using backtracking
// for each parameter that we think we've identified, add it to collectedParams and backtrack
// this allows us to perform dfs through the entire search space without needing to implement the requisite data structure
const decodeWellFormedTuple = (
    // current depth, for debugging purposes
    depth: number,
    // the current data (calldata for top level, dynamic data if decoding a dynamic input)
    data: Uint8Array,
    // the current parameter being decoded
    paramIdx: number,
    // the total number of parameters identified
    collectedParams: Array<DecodedParam>,
    // the offset at which the static calldata ends
    endOfStaticCalldata: number,
    // if we expected a specific number of elements in this tuple
    expectedLength: number | null,
    // if this tuple is an element in an array, every element should either be dynamic (have a length) or not (no length)
    isDynamicArrayElement: boolean | null,
): ParamType[] | null => {
    const debug = (msg: string, ...args: Array<any>) => {
        // console.log("  ".repeat(depth) + msg, ...args);
    };

    // check if the generated params are actually valid by attempting to decode the parameters
    // note that we need to actually check that the generated results are valid (we do this by calling toString)
    const testParams = (params: ParamType[] | null): params is ParamType[] => {
        if (!params) return false;

        try {
            defaultAbiCoder.decode(params, data).map((v) => v.toString());
            return true;
        } catch (e) {
            debug('fail: got illegal parameters', formatParams(params));
            return false;
        }
    };

    // if (paramIdx === 0) {
    //     debug('backtracking');
    //     debug('input:');
    //     chunkString(hexlify(data).substring(2), 64)
    //         .forEach((v, i) =>
    //             debug('  ' + i.toString(16) + ' => ' + v),
    //         );
    // }

    const paramOffset = paramIdx * 32;

    if (paramOffset < endOfStaticCalldata) {
        // we're still in the static region. determine the next param and recurse

        // first, check if this parameter is dynamic
        // if it's dynamic, it should be an offset into calldata
        const maybeOffset = tryParseOffset(data, paramOffset);
        if (maybeOffset !== null) {
            const maybeLength = tryParseLength(data, maybeOffset);

            debug(
                `parameter ${paramIdx} might be dynamic, got offset ${maybeOffset}, len ${maybeLength}, is dynamic element ${isDynamicArrayElement}`,
            );

            if (maybeLength !== null && (isDynamicArrayElement === null || isDynamicArrayElement === true)) {
                const fragment = decodeWellFormedTuple(
                    depth,
                    data,
                    paramIdx + 1,
                    [...collectedParams, { offset: maybeOffset, length: maybeLength }],
                    Math.min(endOfStaticCalldata, maybeOffset),
                    expectedLength,
                    isDynamicArrayElement,
                );
                if (testParams(fragment)) {
                    return fragment;
                }
            }

            if (isDynamicArrayElement === null || isDynamicArrayElement === false) {
                const fragment = decodeWellFormedTuple(
                    depth,
                    data,
                    paramIdx + 1,
                    [...collectedParams, { offset: maybeOffset, length: null }],
                    Math.min(endOfStaticCalldata, maybeOffset),
                    expectedLength,
                    isDynamicArrayElement,
                );
                if (testParams(fragment)) {
                    return fragment;
                }
            }
        }

        // only assume it's static if we're allowed to
        if (isDynamicArrayElement !== null) {
            return null;
        }

        const fragment = decodeWellFormedTuple(
            depth,
            data,
            paramIdx + 1,
            [...collectedParams, ParamType.from('bytes32')],
            endOfStaticCalldata,
            expectedLength,
            isDynamicArrayElement,
        );
        if (testParams(fragment)) {
            return fragment;
        }

        return null;
    }

    // time to resolve our dynamic variables
    debug('reached end of static calldata, resolving dynamic variables', collectedParams.map(formatParam));
    if (expectedLength !== null && collectedParams.length !== expectedLength) {
        debug(`fail: expected ${expectedLength} elements in the tuple but got ${collectedParams.length} instead`);
        return null;
    }

    const maybeResolveDynamicParam = (idx: number): ParamType | undefined => {
        const param = collectedParams[idx];
        if (ParamType.isParamType(param)) {
            return param;
        }

        const nextDynamicParam = collectedParams.find(
            (v, i): v is DynamicPlaceholder => i > idx && !ParamType.isParamType(v),
        );
        const isTrailingDynamicParam = nextDynamicParam === undefined;

        // note that the length of the array != the number of bytes (bytes vs uint[])
        const maybeDynamicElementLen = param.length;

        // extract the data. note that this expects the data to not be overlapping
        const dynamicDataStart = param.offset + (maybeDynamicElementLen !== null ? 32 : 0);
        const dynamicDataEnd = isTrailingDynamicParam ? data.length : nextDynamicParam.offset;
        const dynamicData = data.slice(dynamicDataStart, dynamicDataEnd);

        debug(
            `param ${idx} is ${dynamicDataStart} -> ${dynamicDataEnd} (${dynamicData.length} bytes, ${maybeDynamicElementLen} elements)`,
        );

        if (maybeDynamicElementLen === null) {
            // we don't have a length. what does this mean?
            // - it can't be a bytes/string, because those must have a length
            // - it can't be a dynamic array, because those also must have a length
            // - therefore, it must either be a simple tuple or a static array (which we treat identically)

            debug('trying to decode simple dynamic element', idx);
            const params = decodeWellFormedTuple(depth + 1, dynamicData, 0, [], dynamicData.length, null, null);
            if (params === null) {
                return undefined;
            }

            return ParamType.from(`(${formatParams(params)})`);
        }

        if (maybeDynamicElementLen === 0) {
            // if the element declared zero length, return a sentinel value
            // this could happen if there is:
            // - empty string/bytes
            // - empty dynamic array
            // we can't distinguish between the two, so return the special marker
            return ParamType.from('()[]');
        }

        if (
            maybeDynamicElementLen === dynamicData.length ||
            (dynamicData.length % 32 === 0 &&
                maybeDynamicElementLen === dynamicData.length - countTrailingZeros(dynamicData))
        ) {
            // if either condition is true, then this must be a bytestring:
            // - has exactly the same number of bytes as it claims in the length
            // - is right-padded with zeroes to the next word
            return ParamType.from('bytes');
        }

        // from here on out it gets a bit ambiguous
        // we track all possible results and pick the best one at the end
        const allResults: ParamType[][] = [];

        // let's pretend that what we have is an array of dynamically sized elements
        // where each element has a length prefix. this one is easy to visualize
        // ex: func(string[])
        debug('decoding assuming length');
        const decodedAssumingLength = decodeWellFormedTuple(
            depth + 1,
            dynamicData,
            0,
            [],
            dynamicData.length,
            maybeDynamicElementLen,
            true,
        );
        if (decodedAssumingLength) {
            allResults.push(decodedAssumingLength);
        }

        // let's also pretend that what we have is an array of dynamically sized elements
        // but each element itself *does not* have a length prefix
        // this could happen if we're decoding an array of tuples, where one of the elements
        // is dynamically sized
        // ex: func((uint256,string)[])
        debug('decoding assuming no length');
        const decodedAssumingNoLength = decodeWellFormedTuple(
            depth + 1,
            dynamicData,
            0,
            [],
            dynamicData.length,
            maybeDynamicElementLen,
            false,
        );
        if (decodedAssumingNoLength) {
            allResults.push(decodedAssumingNoLength);
        }

        {
            // finally, let's pretend that what we have is an array of statically sized elements
            // in this case, each element must take the same number of words, so we calculate
            // how many words each element needs and manually decode that

            debug('decoding assuming static');

            const numWords = dynamicData.length / 32;
            const wordsPerElement = Math.floor(numWords / maybeDynamicElementLen);

            if (numWords % maybeDynamicElementLen !== 0 && !isTrailingDynamicParam) {
                // only the trailing param may be right padded
                debug('fail: got uneven dynamic data', dynamicData.length / 32, maybeDynamicElementLen);
                return undefined;
            }

            const staticParseParams: ParamType[] = [];
            for (let elemIdx = 0; elemIdx < maybeDynamicElementLen; elemIdx++) {
                const params = decodeWellFormedTuple(
                    depth + 1,
                    dynamicData.slice(elemIdx * wordsPerElement * 32, (elemIdx + 1) * wordsPerElement * 32),
                    0,
                    [],
                    wordsPerElement * 32,
                    null,
                    null,
                );
                if (params === null || params.length === 0) {
                    debug('fail: to decode element', elemIdx);
                    return undefined;
                }

                if (params.length > 1) {
                    // multiple types, wrap it in a tuple
                    staticParseParams.push(ParamType.from(`(${formatParams(params)})`));
                } else {
                    // one type, all good
                    staticParseParams.push(params[0]);
                }
            }

            allResults.push(staticParseParams);
        }

        const validResults = allResults
            // we only want results that are consistent
            .filter((results) => areParamsConsistent(results))
            // only care about the first if all are consistent
            .map((v) => v[0])
            // how do we know which one is best? usually shorter is better (less complex)
            .sort((a, b) => a.format().length - b.format().length);

        if (validResults.length === 0) {
            debug('fail: got no valid results');
            return undefined;
        }

        debug('got valid results', validResults.map((v) => v.format()).join(' / '));
        return ParamType.from(`${validResults[0].format()}[]`);
    };

    const finalParams: ParamType[] = [];
    for (let i = 0; i < collectedParams.length; i++) {
        const decoded = maybeResolveDynamicParam(i);
        if (!decoded) {
            debug('fail: could not resolve param', i);
            return null;
        }

        finalParams.push(decoded);
    }

    debug('resolved params', finalParams.map(formatParam));

    if (testParams(finalParams)) {
        return finalParams;
    }
    return null;
};

/*
assume the calldata is "well-formed". by well-formed, we mean that all the static parameters come first,
then all the dynamic parameters come after. we assume there is no overlaps in dynamic parameters
and all trailing zeros are explicitly specified
 */
export const guessAbiEncodedData = (bytes: BytesLike): ParamType[] | null => {
    const params = decodeWellFormedTuple(0, arrayify(bytes), 0, [], bytes.length, null, null);
    if (!params) {
        return null;
    }

    // let's clean it up
    const mergeTypes = (types: Array<ParamType>): ParamType => {
        if (types.length === 0) {
            return ParamType.from('()');
        }

        if (types.find((v) => v.baseType === 'tuple') !== undefined) {
            const componentTypes = [];
            for (let i = 0; i < types[0].components.length; i++) {
                componentTypes.push(
                    mergeTypes(Array.from(Array(types.length).keys()).map((v) => types[v].components[i])),
                );
            }
            return ParamType.from(`(${componentTypes.map((v) => v.format()).join(',')})`);
        }
        if (types.find((v) => v.baseType === 'array') !== undefined) {
            return ParamType.from(`${mergeTypes(types.map((v) => v.arrayChildren)).format()}[]`);
        }

        const set = new Set(types.map((v) => v.format()));
        if (set.size === 1) {
            return types[0];
        } else {
            if (set.has('bytes')) {
                return ParamType.from('bytes');
            } else if (set.has('uint256')) {
                return ParamType.from('uint256');
            } else {
                return ParamType.from('bytes32');
            }
        }
    };

    const prettyTypes = (params: Array<ParamType>, vals: Array<any>): Array<ParamType> => {
        return params.map((param, idx) => {
            const val = vals[idx];

            if (param.type === 'bytes32') {
                const leadingZeros = countLeadingZeros(arrayify(val));
                const trailingZeros = countTrailingZeros(arrayify(val));

                if (leadingZeros >= 12 && leadingZeros <= 17) {
                    // it's probably very hard to mine more leading zeros than that
                    return ParamType.from('address');
                } else if (leadingZeros > 16) {
                    return ParamType.from('uint256');
                } else if (trailingZeros > 0) {
                    return ParamType.from(`bytes${32 - trailingZeros}`);
                } else {
                    return ParamType.from('bytes32');
                }
            } else if (param.type === 'bytes') {
                try {
                    toUtf8String(val);
                    return ParamType.from('string');
                } catch {
                    return ParamType.from('bytes');
                }
            } else if (param.baseType === 'array') {
                const childrenTypes = val.map((child: any) => prettyTypes([param.arrayChildren], [child])[0]);
                return ParamType.from(`${mergeTypes(childrenTypes).format()}[]`);
            } else if (param.baseType === 'tuple') {
                return ParamType.from(
                    `(${prettyTypes(param.components, val)
                        .map((v) => v.format())
                        .join(',')})`,
                );
            } else {
                return param;
            }
        });
    };

    return prettyTypes(params, Array.from(defaultAbiCoder.decode(params, bytes)));
};

export const guessFragment = (calldata: BytesLike): FunctionFragment | null => {
    const bytes = arrayify(calldata);
    if (bytes.length === 0) return null;
    const tupleData = bytes.slice(4);

    const params = guessAbiEncodedData(tupleData);
    if (!params) {
        return null;
    }

    const selector = hexlify(bytes.slice(0, 4)).substring(2);
    return FunctionFragment.from(`guessed_${selector}(${formatParams(params)})`);
};
