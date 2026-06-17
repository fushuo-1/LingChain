/**
 * Keil .uvprojx project parser.
 *
 * Extracts compile context (include paths, defines, source files, target
 * device) from a Keil uVision 5 project file.  The file is XML; we use
 * fast-xml-parser to parse it without external dependencies.
 */

import * as fs from 'fs';
import * as path from 'path';
import { XMLParser } from 'fast-xml-parser';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Compile context extracted from a single Keil target configuration. */
export interface CompileContext {
  /** Include directories (absolute paths). */
  includePaths: string[];
  /** Preprocessor defines in KEY=VALUE form (VALUE defaults to 1). */
  defines: string[];
  /** Source files (absolute paths) referenced by the project. */
  sourceFiles: string[];
  /** Target device name, e.g. "STM32G071RBTx". */
  target: string;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export class KeilProject {
  /** Absolute path to the .uvprojx file. */
  readonly projectPath: string;
  /** Absolute path to the directory containing the .uvprojx file. */
  readonly projectDir: string;

  private doc: Record<string, any> | undefined;

  constructor(projectPath: string) {
    this.projectPath = path.resolve(projectPath);
    this.projectDir = path.dirname(this.projectPath);
  }

  /**
   * Read and parse the .uvprojx file.
   * Throws if the file does not exist or is not valid XML.
   */
  parse(): void {
    const xml = fs.readFileSync(this.projectPath, 'utf-8');
    const parser = new XMLParser({
      ignoreAttributes: false,
      // Keil XML uses <Item><FileName>... rather than attributes
    });
    this.doc = parser.parse(xml);
  }

  /**
   * Return all target names defined in the project.
   * Throws if parse() has not been called.
   */
  getTargetNames(): string[] {
    this.ensureParsed();
    const targets = this.doc!['Project']?.['Targets']?.['Target'];
    if (!targets) {
      return [];
    }
    // fast-xml-parser returns an array when there are multiple targets
    const targetList = Array.isArray(targets) ? targets : [targets];
    return targetList.map((t: Record<string, any>) => t['TargetName'] as string ?? '');
  }

  /**
   * Extract compile context for the first target (or the target matching
   * `targetName` if provided).
   */
  getCompileContext(targetName?: string): CompileContext {
    this.ensureParsed();

    const target = this.findTarget(targetName);
    if (!target) {
      return { includePaths: [], defines: [], sourceFiles: [], target: '' };
    }

    const device = this.extractDevice(target);
    const includePaths = this.extractIncludePaths(target);
    const defines = this.extractDefines(target);
    const sourceFiles = this.extractSourceFiles(target);

    return { includePaths, defines, sourceFiles, target: device };
  }

  // -- Internal helpers -----------------------------------------------------

  private ensureParsed(): void {
    if (!this.doc) {
      throw new Error('Call parse() before accessing project data');
    }
  }

  private findTarget(name?: string): Record<string, any> | undefined {
    const targets = this.doc!['Project']?.['Targets']?.['Target'];
    if (!targets) {
      return undefined;
    }
    const targetList: Record<string, any>[] = Array.isArray(targets) ? targets : [targets];
    if (targetList.length === 0) {
      return undefined;
    }
    if (!name) {
      return targetList[0];
    }
    return targetList.find((t) => t['TargetName'] === name) ?? targetList[0];
  }

  private extractDevice(target: Record<string, any>): string {
    // <TargetOption><TargetCommonOption><Device>STM32G071RBTx</Device>
    const common = target?.['TargetOption']?.['TargetCommonOption'];
    return (common?.['Device'] as string) ?? '';
  }

  /**
   * Extract include paths from the ARM/CARM compiler Miscellaneous controls
   * and the IncludePath elements.
   *
   * Keil stores include dirs in two places:
   *   1. <IncludePath> element (semicolon-separated, relative to project dir)
   *   2. <MiscControls> string containing -I flags
   */
  private extractIncludePaths(target: Record<string, any>): string[] {
    const paths: Set<string> = new Set();

    const cads = target?.['TargetOption']?.['TargetArmAds']?.['Cads'];
    const vc = cads?.['VariousControls'];

    // Method 1: <IncludePath> under <VariousControls>
    const includePathStr = vc?.['IncludePath'] as string | undefined;
    if (includePathStr) {
      for (const p of includePathStr.split(';')) {
        const trimmed = p.trim();
        if (trimmed) {
          paths.add(path.resolve(this.projectDir, trimmed));
        }
      }
    }

    // Method 2: -I flags in Miscellaneous controls
    const miscControls = vc?.['MiscControls'] as string | undefined;
    if (miscControls) {
      const iFlagRe = /-I\s*"?([^"\s;]+)"?/g;
      let match: RegExpExecArray | null;
      while ((match = iFlagRe.exec(miscControls)) !== null) {
        const dir = match[1].trim();
        if (dir) {
          paths.add(path.resolve(this.projectDir, dir));
        }
      }
    }

    return [...paths].sort();
  }

  /**
   * Extract preprocessor defines from the ARM/CARM compiler Define string.
   *
   * Keil stores defines as a comma- or semicolon-separated list in <Define>.
   * Each entry is either KEY or KEY=VALUE.
   */
  private extractDefines(target: Record<string, any>): string[] {
    const cads = target?.['TargetOption']?.['TargetArmAds']?.['Cads'];
    const vc = cads?.['VariousControls'];
    const defineStr = vc?.['Define'] as string | undefined;
    if (!defineStr) {
      return [];
    }

    return defineStr
      .split(/[,;]/)
      .map((d: string) => d.trim())
      .filter((d: string) => d.length > 0)
      .sort();
  }

  /**
   * Extract source files from the project Groups and Files tree.
   *
   * Keil stores file references as:
   *   <Project><Groups><Group>
   *     <Files><File><FileName>main.c</FileName><FilePath>.\Src\main.c</FilePath>
   */
  private extractSourceFiles(target: Record<string, any>): string[] {
    const files: Set<string> = new Set();
    const groups = this.doc!['Project']?.['Groups']?.['Group'];

    if (!groups) {
      return [];
    }

    const groupList = Array.isArray(groups) ? groups : [groups];

    for (const group of groupList) {
      const fileList = group?.['Files']?.['File'];
      if (!fileList) {
        continue;
      }
      const fileArray = Array.isArray(fileList) ? fileList : [fileList];

      for (const file of fileArray) {
        const filePath = file?.['FilePath'] as string | undefined;
        if (filePath) {
          // Keil uses .\ relative to the project dir
          const cleaned = filePath.replace(/^\.\\/, '').replace(/^\.?\//, '');
          files.add(path.resolve(this.projectDir, cleaned));
        }
      }
    }

    return [...files].sort();
  }
}
