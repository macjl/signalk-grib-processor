// SPDX-License-Identifier: Apache-2.0
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { gunzipSync } = require('node:zlib')

async function createEncoder() {
  const createModule = require('./vendor/eccodes-module.cjs')
  const { CodesHandle, createEccodes } = require('./vendor/eccodes-wrapper.cjs')
  const wasmBinary = gunzipSync(readFileSync(path.join(__dirname, 'vendor', 'eccodes.wasm.gz')))
  const compiled = await WebAssembly.compile(wasmBinary)
  const module = await createModule({
    instantiateWasm(imports, receive) {
      const instance = new WebAssembly.Instance(compiled, imports)
      receive(instance)
      return instance.exports
    },
  })
  const reader = await createEccodes(module)

  function check(code) {
    if (code !== 0) throw new Error(`ecCodes encoding failed (error ${code})`)
  }

  // The vendored ecCodes/WASM build uses 64-bit pointers and C long/size_t.
  function usingMemory(size, action) {
    const ptr = BigInt(module._malloc(size))
    if (!ptr) throw new Error('Unable to allocate ecCodes/WASM memory')
    try { return action(ptr, Number(ptr)) }
    finally { module._free(ptr) }
  }

  function usingKey(key, action) {
    const ptr = BigInt(module.stringToNewUTF8(key))
    if (!ptr) throw new Error('Unable to allocate ecCodes/WASM key')
    try { return action(ptr) }
    finally { module._free(ptr) }
  }

  class GribMessage extends CodesHandle {
    values() {
      return usingKey('values', key => usingMemory(8, (sizePtr, sizeIndex) => {
        const ptr = module._codes_get_double_array_alloc(this._handle, key, sizePtr)
        if (!ptr) throw new Error('Unable to decode GRIB values')
        try {
          const first = Number(ptr) / 8
          const length = Number(module.HEAPU64[sizeIndex / 8])
          return module.HEAPF64.slice(first, first + length)
        } finally { module._codes_free_array(ptr) }
      }))
    }

    bitmap(size) {
      return usingKey('bitmap', key => usingMemory(size * 8, (ptr, index) =>
        usingMemory(8, (sizePtr, sizeIndex) => {
          module.HEAPU64[sizeIndex / 8] = BigInt(size)
          check(module._codes_get_long_array(this._handle, key, ptr, sizePtr))
          if (module.HEAPU64[sizeIndex / 8] !== BigInt(size)) throw new Error('Invalid GRIB bitmap length')
          return Uint8Array.from(module.HEAPU64.subarray(index / 8, index / 8 + size), Number)
        })))
    }

    setLong(key, value) {
      usingKey(key, ptr => check(module._codes_set_long(this._handle, ptr, BigInt(value))))
    }

    setDouble(key, value) {
      usingKey(key, ptr => check(module._codes_set_double(this._handle, ptr, value)))
    }

    setValues(values) {
      usingKey('values', key => usingMemory(values.byteLength, (ptr, index) => {
        module.HEAPF64.set(values, index / 8)
        check(module._codes_set_double_array(this._handle, key, ptr, BigInt(values.length)))
      }))
    }

    writeBytes(write) {
      usingMemory(16, (ptr, index) => {
        check(module._codes_get_message(this._handle, ptr, ptr + 8n))
        const first = Number(module.HEAPU64[index / 8])
        const size = Number(module.HEAPU64[index / 8 + 1])
        write(module.HEAPU8.subarray(first, first + size))
      })
    }
  }

  return {
    read(bytes, use) {
      const filename = '/processor-message.grib2'
      reader.writeFile(filename, bytes)
      let handle
      try {
        // The upstream wrapper owns decoding. Extend the handle for the
        // encoding functions exposed by our build of the same module.
        handle = reader.openGrib(filename)
        const message = new GribMessage(module, handle._handle, 0)
        return use(message)
      } finally {
        handle?.delete()
        module.FS.unlink(filename)
      }
    },
  }
}

module.exports = { createEncoder }
