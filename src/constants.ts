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
  [Network.MainNet]: 'zil1fql2ezlwgf5cmzee5cc9afge7238pg4exyek5x',
  [Network.TestNet]: 'zil1fql2ezlwgf5cmzee5cc9afge7238pg4exyek5x',
}

export const HUSD: { [key in Networks]: string } = {
  [Network.MainNet]: 'zil1zlk9fgkmn3kcfnqywrdhg5hnmynmakcjmx6sw5',
  [Network.TestNet]: 'zil1zlk9fgkmn3kcfnqywrdhg5hnmynmakcjmx6sw5',
}

export const LAUNCHER: { [key in Networks]: string } = {
  [Network.MainNet]: 'zil1fveammm4wlpxa549n0up96tlwvqwavhuvatu8s',
  [Network.TestNet]: 'zil1fveammm4wlpxa549n0up96tlwvqwavhuvatu8s',
}

export const HEX: { [key in Networks]: string } = {
  [Network.MainNet]: 'zil1f67crjvhrnfqvy0lx33g5pz3dm8synrncg8ka8',
  [Network.TestNet]: 'zil1f67crjvhrnfqvy0lx33g5pz3dm8synrncg8ka8',
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
export const HUSD_HASH = '0x17ec54a2db9c6d84cc0470db7452f3d927bedb12'
export const HASH_HASH = '0x4eF830BF4023beb31dDAc76774F94752CffD803D'
