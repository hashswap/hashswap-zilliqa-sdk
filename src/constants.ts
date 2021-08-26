import { bytes } from '@zilliqa-js/util'

export enum Network {
  MainNet = 'MainNet',
  TestNet = 'TestNet',
}
type Networks = keyof typeof Network

export const APIS: { [key in Networks]: string } = {
  [Network.MainNet]: 'https://api.zilliqa.com',
  [Network.TestNet]: 'https://dev-api.zilliqa.com',
}

export const WSS: { [key in Networks]: string } = {
  [Network.MainNet]: 'wss://api-ws.zilliqa.com',
  [Network.TestNet]: 'wss://dev-ws.zilliqa.com',
}

export const CONTRACTS: { [key in Networks]: string } = {
  [Network.MainNet]: 'zil1hgg7k77vpgpwj3av7q7vv5dl4uvunmqqjzpv2w',
  [Network.TestNet]: 'zil1rf3dm8yykryffr94rlrxfws58earfxzu5lw792',
}

export const DEX: { [key in Networks]: string } = {
  [Network.MainNet]: 'zil1hgg7k77vpgpwj3av7q7vv5dl4uvunmqqjzpv2w',
  [Network.TestNet]: 'zil1rf3dm8yykryffr94rlrxfws58earfxzu5lw792',
}

export const HELLO: { [key in Networks]: string } = {
  [Network.MainNet]: 'zil1hgg7k77vpgpwj3av7q7vv5dl4uvunmqqjzpv2w',
  [Network.TestNet]: 'zil1ffqdxnmng3p2622jk47r3xa4z3pg0wa3r9qard',
}

export const REGISTER: { [key in Networks]: string } = {
  [Network.MainNet]: 'zil134ccch5aftwgaqqmg5dvz2c7ex4879eeul5n7l',
  [Network.TestNet]: 'zil134ccch5aftwgaqqmg5dvz2c7ex4879eeul5n7l',
}

export const HASH: { [key in Networks]: string } = {
  [Network.MainNet]: 'zil12428ahc06xvlsjgazfgp7lmqs459ja0dn268t3',
  [Network.TestNet]: 'zil12428ahc06xvlsjgazfgp7lmqs459ja0dn268t3',
}

export const HUSD: { [key in Networks]: string } = {
  [Network.MainNet]: 'zil1r7zq4xrd4nncm65j2vthljar2kv284qnp2qp7a',
  [Network.TestNet]: 'zil1r7zq4xrd4nncm65j2vthljar2kv284qnp2qp7a',
}

export const LAUNCHER: { [key in Networks]: string } = {
  [Network.MainNet]: 'zil14xrxq7wjahjm0j58327x5skxs2ynlr58l2k04z',
  [Network.TestNet]: 'zil14xrxq7wjahjm0j58327x5skxs2ynlr58l2k04z',
}

export const HEX: { [key in Networks]: string } = {
  [Network.MainNet]: 'zil1stmzdluhem0l0wklnplcsz222n63uyed2kzdwj',
  [Network.TestNet]: 'zil1stmzdluhem0l0wklnplcsz222n63uyed2kzdwj',
}

export enum ILOState {
  Uninitialized = 'Uninitialized',
  Pending = 'Pending',
  Active = 'Active',
  Failed = 'Failed',
  Completed = 'Completed',
}

export const CHAIN_VERSIONS: { [key in Networks]: number } = {
  [Network.MainNet]: bytes.pack(1, 1),
  [Network.TestNet]: bytes.pack(333, 1),
}

export const BASIS = 10000

export const ZERO_HASH = '0x0000000000000000000000000000000000000000'
export const ZIL_HASH = '0x0000000000000000000000000000000000000000'
export const HUSD_HASH = '0x1f840a986dace78dea9253177fcba35598a3d413'
export const HASH_HASH = '0x55547edf0fd199f8491d12501f7f6085685975ed'
