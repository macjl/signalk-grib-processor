# Bundled ecCodes/WASM

The bundled module is built from [eccodes-wasm](https://github.com/meri-imperiumi/eccodes-wasm/tree/759ca8e5c9b55883afff8cea5f9fe4d333e5b970)
and [ECMWF ecCodes 2.48.1](https://github.com/ecmwf/eccodes/tree/cbe16e978f14654ebec4610c9d566089e4ee771e)
under the Apache-2.0 license. The upstream JavaScript wrapper handles decoding.
The build patch exports the ecCodes setters for dimensions and values, bitmap
access and access to the encoded message. It includes libaec for CCSDS and
[OpenJPEG](https://github.com/uclouvain/openjpeg/tree/8314119b067c0fc77834731168daaebd379fdb12)
for JPEG2000. Third-party notices are in [licenses](licenses).

To rebuild, activate Emscripten 6.0.8 and make CMake 3.27, a build backend
such as Make or Ninja, Git and Python 3 available. From the repository root:

```sh
bash tools/rebuild-eccodes.sh
npm test
```

The resulting Node.js module and compressed WASM contain the runtime and its
definitions. Compilers and Python are used only when generating these files.
