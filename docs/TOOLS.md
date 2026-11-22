# Ferramentas por projeto: obrigatórias × sugeridas

"Obrigatória" significa que a fonte citada exige para compilar ou testar. "Sugerida" ajuda, mas nenhuma fonte exige.
Cada tarefa traz os requisitos exatos em `requirements` (com fonte e confiança). Esta página é só o resumo.

| Projeto | Obrigatórias (fonte) | Opcionais / sugeridas |
|---|---|---|
| **Leonida** | Python 3.11+ só com stdlib (`python -I`); .NET 8 SDK (`tools/rpf9dump`); Vulkan SDK (`spirv-as`, `spirv-val`); LLVM 21+ com target AMDGPU (`llvm-mc`; no Windows via WSL); Visual Studio 2022 C++ para o runtime (Leonida README "How to build") | ffmpeg (XMA2/WAV); GPU física para `runtime/test` (`check.py`); GPU AMD para wave64 exato |
| **Xbox2Windows** | Windows x64; Visual Studio 2022 "Desktop development with C++"; CMake + Ninja; Windows SDK 10.0.26100 com DXC (README "First build") | Python 3.11+ para os testes de fixture; DXC 1.8.2502 para `shader_metadata_probe`; GPU com wave64 para os testes `_hardware` |
| **ScarlettX** | Windows x86-64; CMake 3.20+; Ninja; C++20 (MinGW-w64 GCC 13+ ou MSVC 2022); D3D12 runtime + WARP (README "Building & Running Tests") | GPU física (`--gpu`); controle Xbox para testes manuais |
| **rpf9-explorer** | Windows; .NET 10 SDK (README "Build from source"); .NET 8 para o `rpf9dump`/IndexBuilder (PR #1) | VC++ + Windows SDK para os helpers de mídia; SDK Bink (licenciado) e libopus; ffmpeg; **Ghidra ou IDA para análise de BCPack (sugestão do proprietário, não citada pelas fontes)** |
| **americas-recomp** | CMake; submódulos (`git submodule update --init --recursive`); Vulkan SDK para `spirv-val`/`glslangValidator`; para o oracle de hardware: GPU AMD com driver (HIP/comgr no Windows, HSA no Linux) (CONTRIBUTING, `docs/dev/HW_ORACLE.md`) | Build só do relinker funciona no macOS (`-DANYPS5_RELINKER_ONLY=ON`); Python 3 para parte dos testes |

## Para participar pelo coordenador

| Item | Status |
|---|---|
| Cliente MCP com transporte HTTP (Claude Code ≥ versão com `claude mcp add --transport http`) | obrigatório |
| `git` com HTTPS | obrigatório para tarefas executáveis |
| Node 18+ (para o `tools/git-credential-gta6.mjs`) | obrigatório para usar repositório de trabalho |
| Conta GitHub | **não** obrigatória (anônimos usam o repositório de trabalho) |
| Cópia própria e legítima do jogo | só quando a tarefa marca `game_files: yes` na fase em questão |
