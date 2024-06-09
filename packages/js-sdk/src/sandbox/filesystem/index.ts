import { PlainMessage } from '@bufbuild/protobuf'
import {
  createPromiseClient,
  Transport,
  PromiseClient,
  ConnectError,
  Code,
} from '@connectrpc/connect'

import { ConnectionOpts, defaultUsername, Username } from '../../connectionConfig'
import { EnvdApiClient } from '../../envd/api'
import { Filesystem as FilesystemService } from '../../envd/filesystem/filesystem_connect'
import {
  EntryInfo as FsEntryInfo,
} from '../../envd/filesystem/filesystem_pb'
import { WatchHandle, FilesystemEvent } from './watchHandle'

export type EntryInfo = PlainMessage<FsEntryInfo>

export interface FilesystemRequestOpts extends Partial<Pick<ConnectionOpts, 'requestTimeoutMs'>> {
  user?: Username
}

export class Filesystem {
  private readonly rpc: PromiseClient<typeof FilesystemService>
  private readonly envdApi: EnvdApiClient

  constructor(
    transport: Transport,
    envdApiUrl: string,
    private readonly connectionConfig: ConnectionOpts,
  ) {
    this.envdApi = new EnvdApiClient({ apiUrl: envdApiUrl })
    this.rpc = createPromiseClient(FilesystemService, transport)
  }

  async read(path: string, opts?: FilesystemRequestOpts & { format?: 'text' }): Promise<string>
  async read(path: string, opts?: FilesystemRequestOpts & { format: 'bytes' }): Promise<Uint8Array>
  async read(path: string, opts?: FilesystemRequestOpts & { format: 'blob' }): Promise<Blob>
  async read(path: string, opts?: FilesystemRequestOpts & { format: 'stream' }): Promise<ReadableStream<Uint8Array>>
  async read(path: string, opts?: FilesystemRequestOpts & { format?: 'text' | 'stream' | 'bytes' | 'blob' }): Promise<unknown> {
    const requestTimeoutMs = opts?.requestTimeoutMs ?? this.connectionConfig.requestTimeoutMs

    const format = opts?.format ?? 'text'

    const response = await this.envdApi.api.GET('/files/{path}', {
      params: {
        path: {
          path,
        },
        query: {
          username: opts?.user || defaultUsername,
        },
      },
      parseAs: format === 'bytes' ? 'arrayBuffer' : format,
      signal: requestTimeoutMs ? AbortSignal.timeout(requestTimeoutMs) : undefined,
    })

    if (format === 'bytes') {
      return new Uint8Array(response.data as ArrayBuffer)
    }

    return response.data
  }

  async write(path: string, data: string | ArrayBuffer | Blob | ReadableStream, opts?: FilesystemRequestOpts): Promise<void> {
    const requestTimeoutMs = opts?.requestTimeoutMs ?? this.connectionConfig.requestTimeoutMs
    const blob = await new Response(data).blob()

    await this.envdApi.api.POST('/files/{path}', {
      params: {
        path: {
          path,
        },
        query: {
          username: opts?.user || defaultUsername,
        },
      },
      bodySerializer() {
        const fd = new FormData()

        fd.append('file', blob)

        return fd
      },
      body: {},
      signal: requestTimeoutMs ? AbortSignal.timeout(requestTimeoutMs) : undefined,
    })
  }

  async list(path: string, opts?: FilesystemRequestOpts): Promise<EntryInfo[]> {
    const requestTimeoutMs = opts?.requestTimeoutMs ?? this.connectionConfig.requestTimeoutMs

    const res = await this.rpc.list({
      path,
      user: {
        selector: {
          case: 'username',
          value: opts?.user || defaultUsername,
        },
      },
    }, {
      signal: requestTimeoutMs ? AbortSignal.timeout(requestTimeoutMs) : undefined,
    })

    return res.entries
  }

  async makeDir(path: string, opts?: FilesystemRequestOpts): Promise<void> {
    const requestTimeoutMs = opts?.requestTimeoutMs ?? this.connectionConfig.requestTimeoutMs

    await this.rpc.makeDir({
      path,
      user: {
        selector: {
          case: 'username',
          value: opts?.user || defaultUsername,
        },
      },
    }, {
      signal: requestTimeoutMs ? AbortSignal.timeout(requestTimeoutMs) : undefined,
    })
  }

  async remove(path: string, opts?: FilesystemRequestOpts): Promise<void> {
    const requestTimeoutMs = opts?.requestTimeoutMs ?? this.connectionConfig.requestTimeoutMs

    await this.rpc.remove({
      path,
      user: {
        selector: {
          case: 'username',
          value: opts?.user || defaultUsername,
        },
      },
    }, {
      signal: requestTimeoutMs ? AbortSignal.timeout(requestTimeoutMs) : undefined,
    })
  }

  async exists(path: string, opts?: FilesystemRequestOpts): Promise<boolean> {
    const requestTimeoutMs = opts?.requestTimeoutMs ?? this.connectionConfig.requestTimeoutMs

    try {
      await this.rpc.stat({
        path,
        user: {
          selector: {
            case: 'username',
            value: opts?.user || defaultUsername,
          },
        },
      }, {
        signal: requestTimeoutMs ? AbortSignal.timeout(requestTimeoutMs) : undefined,
      })

      return true
    } catch (err) {
      const connectErr = ConnectError.from(err)

      if (connectErr.code === Code.NotFound) {
        return false
      }

      throw err
    }
  }

  async watch(
    path: string,
    onEvent: (event: FilesystemEvent) => void | Promise<void>,
    opts?: FilesystemRequestOpts & { timeout?: number },
  ): Promise<WatchHandle> {
    const requestTimeoutMs = opts?.requestTimeoutMs ?? this.connectionConfig.requestTimeoutMs

    const controller = new AbortController()

    const reqTimeout = setTimeout(() => {
      controller.abort()
    }, requestTimeoutMs)

    const events = this.rpc.watch({
      path,
      user: {
        selector: {
          case: 'username',
          value: opts?.user || defaultUsername,
        },
      },
    }, {
      signal: controller.signal,
    })

    clearTimeout(reqTimeout)

    const timeout = opts?.timeout ?? requestTimeoutMs

    if (timeout > 0) {
      setTimeout(() => {
        controller.abort()
      }, timeout)
    }

    return new WatchHandle(
      () => controller.abort(),
      events,
      onEvent,
    )
  }
}
