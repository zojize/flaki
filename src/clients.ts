import process from 'node:process'
import { GoogleGenAI } from '@google/genai'
import { Octokit } from 'octokit'

const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const GITHUB_TOKEN = process.env.GITHUB_TOKEN

if (!GEMINI_API_KEY) {
  throw new Error('GEMINI_API_KEY environment variable is required')
}

if (!GITHUB_TOKEN) {
  throw new Error('GITHUB_TOKEN environment variable is required')
}

export const genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY })
export const octokit = new Octokit({ auth: GITHUB_TOKEN })
