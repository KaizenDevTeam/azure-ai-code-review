import { readFileSync } from 'fs';
import * as core from '@actions/core';
import { Octokit } from '@octokit/rest';
import { AzureOpenAI } from 'openai';
import parseDiff, { Chunk, File } from 'parse-diff';
import minimatch from 'minimatch';
import fetch from 'node-fetch';

const GITHUB_TOKEN: string = core.getInput('GITHUB_TOKEN');
const AZURE_OPENAI_ENDPOINT: string = core.getInput('AZURE_OPENAI_ENDPOINT');
const AZURE_OPENAI_API_KEY: string = core.getInput('AZURE_OPENAI_API_KEY');
const AZURE_OPENAI_API_VERSION: string = core.getInput('AZURE_OPENAI_API_VERSION');
const AZURE_OPENAI_DEPLOYMENT: string = core.getInput('AZURE_OPENAI_DEPLOYMENT');
const TEAMS_WEBHOOK_URL: string = core.getInput('TEAMS_WEBHOOK_URL');

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const client = new AzureOpenAI({
  endpoint: AZURE_OPENAI_ENDPOINT,
  apiKey: AZURE_OPENAI_API_KEY,
  apiVersion: AZURE_OPENAI_API_VERSION,
  deployment: AZURE_OPENAI_DEPLOYMENT,  
  defaultHeaders: {
    'Ocp-Apim-Subscription-Key': AZURE_OPENAI_API_KEY,
  },
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || '', 'utf8')
  );
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? '',
    description: prResponse.data.body ?? '',
  };
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: 'diff' },
  });
  // @ts-expect-error - response.data is a string
  return response.data;
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const file of parsedDiff) {
    if (file.to === '/dev/null') continue; // Ignore deleted files
    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
      const aiResponse = await getAIResponse(prompt);
      if (aiResponse) {
        const newComments = createComment(file, chunk, aiResponse);
        if (newComments) {
          comments.push(...newComments);
        }
      }
    }
  }
  return comments;
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  return `Your task is to review pull requests. Instructions:
- Provide the response in following JSON format:  {"reviews": [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]}
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- IMPORTANT: NEVER suggest adding comments to the code.

Review the following code diff in the file "${
    file.to
  }" and take the pull request title and description into account when writing the response.
  
Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${chunk.changes
  // @ts-expect-error - ln and ln2 exists where needed
  .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
  .join('\n')}
\`\`\`
`;
}

async function getAIResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
}> | null> {
  try {
    const response = await client.chat.completions.create({
      model: '',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You are a code review assistant. Respond in JSON format. ' + prompt,
        },
      ],
    });

    const res = response.choices[0].message?.content?.trim() || '{}';
    return JSON.parse(res).reviews;
  } catch (error) {
    console.error('Error:', error);
    return null;
  }
}

function createComment(
  file: File,
  chunk: Chunk,
  aiResponses: Array<{
    lineNumber: string;
    reviewComment: string;
  }>
): Array<{ body: string; path: string; line: number }> {
  return aiResponses.flatMap((aiResponse) => {
    if (!file.to) {
      return [];
    }
    return {
      body: aiResponse.reviewComment,
      path: file.to,
      line: Number(aiResponse.lineNumber),
    };
  });
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: 'COMMENT',
  });
}

async function sendTeamsMessage(prDetails: PRDetails, comments: Array<{ body: string; path: string; line: number }>): Promise<void> {
  if (!TEAMS_WEBHOOK_URL) {
    console.log('Teams webhook URL not provided, skipping Teams notification');
    return;
  }

  const prUrl = `https://github.com/${prDetails.owner}/${prDetails.repo}/pull/${prDetails.pull_number}`;
  
  const messageBody = {
    "@type": "MessageCard",
    "@context": "http://schema.org/extensions",
    "themeColor": "0076D7",
    "summary": `New code review comments on PR: ${prDetails.title}`,
    "sections": [{
      "activityTitle": `🤖 Code Review Bot - New Comments`,
      "facts": [
        {
          "name": "Repository",
          "value": `${prDetails.owner}/${prDetails.repo}`
        },
        {
          "name": "Number of Comments",
          "value": comments.length.toString()
        }
      ]
    }],
    "potentialAction": [{
      "@type": "OpenUri",
      "name": "View Pull Request",
      "targets": [{
        "os": "default",
        "uri": prUrl
      }]
    }]
  };

  try {
    const response = await fetch(TEAMS_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(messageBody)
    });

    if (!response.ok) {
      throw new Error(`Failed to send Teams message: ${response.statusText}`);
    }
  } catch (error) {
    console.error('Error sending Teams message:', error);
  }
}

async function main() {
  const prDetails = await getPRDetails();

  // Print the prDetails
  console.log("PR Details:", prDetails);

  let diff: string | null;
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8')
  );

  if (eventData.action === 'opened') {
    diff = await getDiff(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
    );
  } else if (eventData.action === 'synchronize') {
    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;

    const response = await octokit.repos.compareCommits({
      headers: {
        accept: 'application/vnd.github.v3.diff',
      },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: newBaseSha,
      head: newHeadSha,
    });

    diff = String(response.data);
  } else {
    console.log('Unsupported event:', process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log('No diff found');
    return;
  }

  const parsedDiff = parseDiff(diff);

  const excludePatterns = core
    .getInput('exclude')
    .split(',')
    .map((s) => s.trim());

  const filteredDiff = parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) =>
      minimatch(file.to ?? '', pattern)
    );
  });

  console.log("Filtered Diff:", JSON.stringify(filteredDiff));

  const comments = await analyzeCode(filteredDiff, prDetails);
  console.log("Comments:", JSON.stringify(comments));

  if (comments.length > 0) {
    await createReviewComment(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
      comments
    );
    
    // Send Teams message with the comments
    await sendTeamsMessage(prDetails, comments);
  }
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
