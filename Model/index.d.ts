export const config: {
    bot: {
        maxRetry: number
    }
    web: {
        password: {
            [key: string]: string
            default: string
        }
    }
    [key: string]: any
}

export const configSave: (config?: typeof config) => Promise<void>